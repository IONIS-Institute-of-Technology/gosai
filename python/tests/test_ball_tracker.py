from __future__ import annotations

from gosai_py.drivers.ball import _BallTracker, _Detection


def _det(x: float = 100.0, y: float = 100.0, r: float = 20.0) -> _Detection:
    return _Detection(x=x, y=y, r=r, score=0.9)


def test_new_detection_renders_immediately_at_raw_position() -> None:
    tracker = _BallTracker()

    stable = tracker.update([_det(123.0, 456.0)], 1.0)

    assert len(stable) == 1
    assert stable[0].x == 123.0
    assert stable[0].y == 456.0


def test_positions_pass_through_unsmoothed() -> None:
    tracker = _BallTracker()

    tracker.update([_det(100.0, 100.0)], 1.0)
    stable = tracker.update([_det(140.0, 100.0)], 1.1)

    assert len(stable) == 1
    assert stable[0].x == 140.0
    assert stable[0].y == 100.0


def test_track_survives_short_detector_miss() -> None:
    tracker = _BallTracker(max_miss=3, render_miss=2)

    tracker.update([_det()], 1.0)
    tracker.update([_det(110.0, 100.0)], 1.1)

    stable = tracker.update([], 1.2)

    assert len(stable) == 1
    assert stable[0].missed == 1


def test_track_dropped_after_max_miss() -> None:
    tracker = _BallTracker(max_miss=2, render_miss=1)

    tracker.update([_det()], 1.0)
    tracker.update([], 1.1)
    tracker.update([], 1.2)
    stable = tracker.update([], 1.3)

    assert stable == []
    assert tracker.tracks == []


def test_moving_ball_stays_on_one_track() -> None:
    tracker = _BallTracker()

    tracker.update([_det(100.0, 100.0)], 1.0)
    tracker.update([_det(140.0, 100.0)], 1.05)
    tracker.update([_det(180.0, 100.0)], 1.10)

    assert len(tracker.tracks) == 1
    assert tracker.tracks[0].vx > 0
