from __future__ import annotations

from gosai_py.drivers.ball import _BallTracker, _Detection


def _det(x: float = 100.0, y: float = 100.0, r: float = 20.0) -> _Detection:
    return _Detection(x=x, y=y, r=r, score=0.5)


def test_tracker_requires_consecutive_hits_before_rendering() -> None:
    tracker = _BallTracker(min_age=2, max_miss=3, render_miss=2)

    assert tracker.update([_det()], 1.0) == []
    assert tracker.update([], 1.03) == []
    assert tracker.tracks == []

    assert tracker.update([_det()], 1.06) == []
    stable = tracker.update([_det(102.0, 100.0)], 1.09)

    assert len(stable) == 1


def test_confirmed_track_survives_short_detector_miss() -> None:
    tracker = _BallTracker(min_age=2, max_miss=3, render_miss=2)

    assert tracker.update([_det()], 1.0) == []
    assert len(tracker.update([_det(110.0, 100.0)], 1.1)) == 1

    stable = tracker.update([], 1.2)

    assert len(stable) == 1
    assert stable[0].missed == 1


def test_unconfirmed_intermittent_detection_never_renders() -> None:
    tracker = _BallTracker(min_age=2, max_miss=3, render_miss=2)

    assert tracker.update([_det()], 1.0) == []
    assert tracker.update([], 1.03) == []
    assert tracker.update([_det()], 1.06) == []

    assert len(tracker.tracks) == 1
    assert tracker.tracks[0].age == 1
