"""Small threading primitives shared by the bridge and drivers.

- `LatestValueWorker` hands values to a callback on its own thread and keeps
  only the newest pending value, so a slow consumer lowers its own rate instead
  of blocking the producer or falling behind.
- `BoundedQueueWorker` hands every value to a callback in order, dropping the
  oldest pending value when its queue is full.
- `SerialQueue` runs submitted tasks one at a time on a worker thread that
  exits when the queue stays idle.
"""

from __future__ import annotations

import threading
import time
import traceback
from collections import deque
from collections.abc import Callable
from typing import Any

_EMPTY = object()


class LatestValueWorker:
    """Deliver the most recent offered value to `callback` on a dedicated thread."""

    def __init__(
        self,
        callback: Callable[[Any], None],
        *,
        name: str,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        self._callback = callback
        self._on_error = on_error
        self._cond = threading.Condition()
        self._pending: Any = _EMPTY
        self._closed = False
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self._thread.start()

    def offer(self, value: Any) -> None:
        """Replace the pending value. Never blocks on the callback."""
        with self._cond:
            if self._closed:
                return
            self._pending = value
            self._cond.notify()

    def close(self) -> None:
        """Drop any pending value and ask the thread to exit after its current callback."""
        with self._cond:
            self._closed = True
            self._pending = _EMPTY
            self._cond.notify_all()

    def join(self, timeout: float | None = None) -> bool:
        """Wait for the thread to exit. Returns True when it has."""
        if threading.current_thread() is self._thread:
            return False
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def _run(self) -> None:
        while True:
            with self._cond:
                while self._pending is _EMPTY and not self._closed:
                    self._cond.wait()
                if self._closed:
                    return
                value = self._pending
                self._pending = _EMPTY
            try:
                self._callback(value)
            except Exception as exc:
                if self._on_error is not None:
                    self._on_error(exc)


class BoundedQueueWorker(LatestValueWorker):
    """Deliver every offered value in order, up to `maxsize` pending values.

    When the queue is full the oldest pending value is dropped and `on_drop`
    is called, so a consumer that falls behind loses the stalest input.
    """

    def __init__(
        self,
        callback: Callable[[Any], None],
        *,
        name: str,
        maxsize: int,
        on_error: Callable[[BaseException], None] | None = None,
        on_drop: Callable[[], None] | None = None,
    ) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be at least 1")
        self._queue: deque[Any] = deque()
        self._maxsize = maxsize
        self._on_drop = on_drop
        super().__init__(callback, name=name, on_error=on_error)

    def offer(self, value: Any) -> None:
        dropped = False
        with self._cond:
            if self._closed:
                return
            if len(self._queue) >= self._maxsize:
                self._queue.popleft()
                dropped = True
            self._queue.append(value)
            self._cond.notify()
        if dropped and self._on_drop is not None:
            self._on_drop()

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._queue.clear()
            self._cond.notify_all()

    def _run(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait()
                if self._closed:
                    return
                value = self._queue.popleft()
            try:
                self._callback(value)
            except Exception as exc:
                if self._on_error is not None:
                    self._on_error(exc)


class SerialQueue:
    """Run tasks in submission order on one worker thread.

    The thread starts on the first submission and exits after `idle_timeout_s`
    without work, so idle queues cost nothing.
    """

    def __init__(self, name: str, *, idle_timeout_s: float = 30.0) -> None:
        self._name = name
        self._idle_timeout_s = idle_timeout_s
        self._cond = threading.Condition()
        self._tasks: deque[tuple[Callable[[], None], Callable[[], None] | None]] = deque()
        self._thread: threading.Thread | None = None
        self._closed = False

    def submit(self, task: Callable[[], None], cancel: Callable[[], None] | None = None) -> None:
        """Queue `task`. `cancel` runs instead if the queue closes before `task` starts."""
        with self._cond:
            if self._closed:
                raise RuntimeError(f"queue {self._name} is closed")
            self._tasks.append((task, cancel))
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
                self._thread.start()
            else:
                self._cond.notify()

    def close(self, timeout: float | None = None) -> bool:
        """Refuse new tasks, cancel queued ones, and wait for the running task.

        Returns True when the worker thread has exited.
        """
        with self._cond:
            self._closed = True
            pending = list(self._tasks)
            self._tasks.clear()
            self._cond.notify_all()
        for _task, cancel in pending:
            if cancel is not None:
                try:
                    cancel()
                except Exception:
                    traceback.print_exc()
        return self.join(timeout)

    def join(self, timeout: float | None = None) -> bool:
        with self._cond:
            thread = self._thread
        if thread is None or thread is threading.current_thread():
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def _run(self) -> None:
        while True:
            with self._cond:
                deadline = time.monotonic() + self._idle_timeout_s
                while not self._tasks and not self._closed:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cond.wait(remaining)
                if not self._tasks:
                    self._thread = None
                    return
                task, _cancel = self._tasks.popleft()
            try:
                task()
            except Exception:
                # Tasks report their own errors; this only keeps the worker alive.
                traceback.print_exc()
