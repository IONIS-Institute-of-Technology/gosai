from __future__ import annotations

import threading

import pytest

from fakes import RecordingContext, check_events, check_result, wait_until
from gosai_py.drivers.interpolate import InterpolateDriver


def _job_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name.startswith("interp:")]


def test_steps_move_toward_the_target() -> None:
    context = RecordingContext()
    driver = InterpolateDriver(context)

    driver.execute("interpolate_points", {"name": "p", "points": [[0.0, 0.0]], "amount": 1})
    wait_until(lambda: not _job_threads())
    result = check_result(
        InterpolateDriver,
        "interpolate_points",
        driver.execute(
            "interpolate_points", {"name": "p", "points": [[8.0, 16.0]], "factor": 0.5, "amount": 3}
        ),
    )
    wait_until(lambda: len(context.emitted("interpolated_data")) == 4)

    assert result == {"name": "p"}
    steps = [e["points"] for e in context.emitted("interpolated_data")]
    assert steps == [[[0.0, 0.0]], [[4.0, 8.0]], [[6.0, 12.0]], [[7.0, 14.0]]]
    check_events(InterpolateDriver, context)


def test_a_new_job_cancels_the_one_it_replaces() -> None:
    context = RecordingContext()
    driver = InterpolateDriver(context)
    driver.execute(
        "interpolate_points", {"name": "p", "points": [1.0], "amount": 1000, "duration": 100}
    )
    wait_until(lambda: len(context.emitted("interpolated_data")) == 1)
    first = _job_threads()

    driver.execute("interpolate_points", {"name": "p", "points": [2.0], "amount": 1})

    assert len(first) == 1 and not first[0].is_alive()
    wait_until(lambda: not _job_threads())
    assert context.emitted("interpolated_data")[-1]["name"] == "p"
    assert len(context.emitted("interpolated_data")) == 2


def test_cleanup_stops_running_jobs() -> None:
    driver = InterpolateDriver(RecordingContext())
    driver.execute(
        "interpolate_points", {"name": "a", "points": [1.0], "amount": 1000, "duration": 100}
    )
    driver.execute(
        "interpolate_points", {"name": "b", "points": [1.0], "amount": 1000, "duration": 100}
    )

    driver.cleanup()

    assert not _job_threads()


def test_reset_and_validation() -> None:
    driver = InterpolateDriver(RecordingContext())
    assert driver.execute("reset", "p") is None
    assert driver.execute("reset", None) is None
    with pytest.raises(ValueError, match="amount"):
        driver.execute("interpolate_points", {"amount": 0})


def test_int_targets_ease_from_float_values() -> None:
    from gosai_py.drivers.interpolate import _interpolate

    assert _interpolate([[0.5, 1.5]], [[1, 2]], factor=0.5, depth=1) == [[0.75, 1.75]]
    assert _interpolate(0.5, 1, factor=0.5, depth=0) == 0.75
    assert _interpolate([0.5], ["a"], factor=0.5, depth=1) == ["a"]
