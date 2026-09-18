"""Interpolate driver.

Smooths numeric streams over time. `interpolate_points` starts a job that
moves the stream `name` toward `points` over `amount` steps spread across
`duration` seconds, emitting `interpolated_data` at each step. Each step moves
`factor` (0..1) of the way from the previous value. `depth` is how many list
levels to descend before lerping: 1 for `[[x, y], ...]` where each `[x, y]` is
a leaf, 0 to lerp the top list itself.

A new job for a stream cancels the one it replaces.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any, ClassVar

import msgspec
from msgspec import Meta

from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.smoothing import lerp

JOB_JOIN_TIMEOUT_S = 1.0


class InterpolateParams(msgspec.Struct, kw_only=True):
    name: str = "default"
    points: list[Any] = msgspec.field(default_factory=list)
    factor: float = 0.5
    depth: int = 1
    amount: Annotated[int, Meta(ge=1)] = 1
    duration: Annotated[float, Meta(ge=0.0)] = 0.0


class InterpolateResult(msgspec.Struct, kw_only=True):
    name: str


class InterpolatedPayload(msgspec.Struct, kw_only=True):
    name: str
    points: list[Any]


@dataclass(frozen=True)
class _Job:
    thread: threading.Thread
    cancel: threading.Event


class InterpolateDriver(BaseDriver):
    name = "interpolate"
    description = "Smoothly interpolate any numeric stream over time."
    events: ClassVar[Mapping[str, Event]] = {
        # Queued, not latest-only: the bridge keeps one latest value per event,
        # so with several streams a slow reader would lose other streams' last
        # steps, and with them their targets.
        "interpolated_data": Event(InterpolatedPayload, "One step of a stream's interpolation."),
    }
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._lock = threading.Lock()
        self._previous: dict[str, list[Any]] = {}
        self._jobs: dict[str, _Job] = {}

    @action("Interpolate the stream `name` toward `points`, replacing its running job.")
    def interpolate_points(self, params: InterpolateParams) -> InterpolateResult:
        cancel = threading.Event()
        thread = threading.Thread(
            target=self._run, args=(params, cancel), name=f"interp:{params.name}", daemon=True
        )
        job = _Job(thread, cancel)
        with self._lock:
            previous = self._jobs.get(params.name)
            self._jobs[params.name] = job
        if previous is not None:
            _stop(previous)
        job.thread.start()
        return InterpolateResult(name=params.name)

    @action("Forget the last value of one stream, or of every stream when null.")
    def reset(self, name: str | None) -> None:
        with self._lock:
            if name is None:
                self._previous.clear()
            else:
                self._previous.pop(name, None)

    def cleanup(self) -> None:
        with self._lock:
            jobs = list(self._jobs.values())
            self._jobs.clear()
        for job in jobs:
            _stop(job)

    def _run(self, params: InterpolateParams, cancel: threading.Event) -> None:
        step_s = params.duration / params.amount
        for _ in range(params.amount):
            started = time.perf_counter()
            if cancel.is_set() or self.stop_requested():
                return
            with self._lock:
                current = _interpolate(
                    self._previous.get(params.name), params.points, params.factor, params.depth
                )
                self._previous[params.name] = current
            self.emit("interpolated_data", {"name": params.name, "points": current})
            remaining = step_s - (time.perf_counter() - started)
            if remaining > 0 and cancel.wait(remaining):
                return


def _stop(job: _Job) -> None:
    job.cancel.set()
    if job.thread.is_alive() and job.thread is not threading.current_thread():
        job.thread.join(JOB_JOIN_TIMEOUT_S)


def _interpolate(prev: Any, current: Any, factor: float, depth: int) -> Any:
    if prev is None or not _same_shape(prev, current):
        return current
    if isinstance(current, list) and current == []:
        return prev
    if depth <= 0:
        return _lerp_leaf(prev, current, factor)
    if isinstance(prev, list) and isinstance(current, list):
        return [_interpolate(p, c, factor, depth - 1) for p, c in zip(prev, current, strict=True)]
    return current


def _lerp_leaf(a: Any, b: Any, t: float) -> Any:
    """Lerp numbers, or the numeric entries of two lists; other entries take `b`."""
    if isinstance(a, list) and isinstance(b, list):
        return [
            lerp(x, y, t) if _is_number(x) and _is_number(y) else y
            for x, y in zip(a + [None] * (len(b) - len(a)), b, strict=False)
        ]
    return lerp(a, b, t) if _is_number(a) and _is_number(b) else b


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _same_shape(a: Any, b: Any) -> bool:
    # JSON from JavaScript sends whole numbers as ints, so 1 and 0.5 match.
    if _is_number(a) and _is_number(b):
        return True
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        if len(a) != len(b):
            return False
        return not a or _same_shape(a[0], b[0])
    return True
