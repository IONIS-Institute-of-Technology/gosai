"""The One Euro filter's lag, jitter rejection and restarts."""

from __future__ import annotations

import numpy as np
import pytest

from gosai_py.smoothing import OneEuro, lerp

MIN_CUTOFF_HZ = 1.5
BETA = 0.02
RATE_HZ = 30.0
FRAME_MS = 1000.0 / RATE_HZ


def _ramp_lag_ms(speed: float = 500.0, steps: int = 300) -> float:
    """Steady-state trailing error of the filter on a constant-velocity ramp, as a lag."""
    smoother = OneEuro(MIN_CUTOFF_HZ, BETA)
    value = out = 0.0
    for step in range(steps):
        t_ms = step * FRAME_MS
        value = speed * t_ms / 1000.0
        out = float(smoother(np.array([value]), t_ms)[0])
    return (value - out) / speed * 1000.0


def test_constant_input_passes_through_exactly() -> None:
    smoother = OneEuro(MIN_CUTOFF_HZ, BETA)
    value = np.array([[1.5, -2.0], [0.0, 7.25]])

    for step in range(50):
        out = smoother(value, step * FRAME_MS)

    assert out == pytest.approx(value)


def test_ramp_lag_is_far_below_the_old_body_smoother() -> None:
    speed = 500.0
    lag_ms = _ramp_lag_ms(speed)

    # The old body smoother: an exponential moving average with a fixed alpha.
    value = out = 0.0
    for step in range(300):
        value = speed * (step * FRAME_MS) / 1000.0
        out = lerp(out, value, 0.4)
    ema_lag_ms = (value - out) / speed * 1000.0

    assert 0.0 < lag_ms < 25.0
    assert ema_lag_ms == pytest.approx(50.0, abs=1.0)


def test_stationary_jitter_is_attenuated() -> None:
    rng = np.random.default_rng(7)
    noise = rng.normal(0.0, 2.0, 900)
    smoother = OneEuro(MIN_CUTOFF_HZ, BETA)

    filtered = [float(smoother(np.array([x]), step * FRAME_MS)[0]) for step, x in enumerate(noise)]

    settled = slice(60, None)
    assert np.std(filtered[settled]) * 2.0 < np.std(noise[settled])


def test_nan_elements_pass_through_without_poisoning_the_state() -> None:
    smoother = OneEuro(MIN_CUTOFF_HZ, BETA)
    smoother(np.array([10.0, 10.0]), 0.0)
    smoother(np.array([10.0, 10.0]), FRAME_MS)

    hole = smoother(np.array([np.nan, 10.0]), 2 * FRAME_MS)
    back = smoother(np.array([10.0, 10.0]), 3 * FRAME_MS)

    assert np.isnan(hole[0]) and hole[1] == pytest.approx(10.0)
    assert back == pytest.approx([10.0, 10.0])


def test_an_element_missing_from_the_first_frame_starts_when_it_appears() -> None:
    smoother = OneEuro(MIN_CUTOFF_HZ, BETA)
    smoother(np.array([np.nan, 0.0]), 0.0)

    out = smoother(np.array([4.0, 0.0]), FRAME_MS)

    # The element starts at its own value instead of climbing out of NaN.
    assert out == pytest.approx([4.0, 0.0])


def test_a_time_gap_or_a_shape_change_restarts_and_a_stalled_clock_holds() -> None:
    smoother = OneEuro(MIN_CUTOFF_HZ, BETA)
    smoother(np.array([0.0]), 0.0)
    smoother(np.array([0.0]), FRAME_MS)

    assert smoother(np.array([5.0]), FRAME_MS + 600.0) == pytest.approx([5.0])
    # Same timestamp again: the output holds instead of jumping to the raw value.
    assert smoother(np.array([9.0]), FRAME_MS + 600.0) == pytest.approx([5.0])
    assert smoother(np.array([1.0, 2.0]), FRAME_MS + 700.0) == pytest.approx([1.0, 2.0])
    smoother.reset()
    assert smoother(np.array([3.0, 4.0]), FRAME_MS + 733.0) == pytest.approx([3.0, 4.0])


def test_smoothing_follows_elapsed_time_not_the_frame_count() -> None:
    steady = OneEuro(MIN_CUTOFF_HZ, BETA)
    sparse = OneEuro(MIN_CUTOFF_HZ, BETA)
    speed = 200.0

    for step in range(30):
        t_ms = step * FRAME_MS
        steady(np.array([speed * t_ms / 1000.0]), t_ms)
    # A third of the frames over the same span, with uneven spacing.
    for t_ms in [0.0, 120.0, 190.0, 310.0, 460.0, 590.0, 700.0, 830.0, 966.7]:
        out = sparse(np.array([speed * t_ms / 1000.0]), t_ms)

    steady_out = steady(np.array([speed * 966.7 / 1000.0]), 966.7)
    assert float(out[0]) == pytest.approx(float(steady_out[0]), rel=0.02)


def test_a_rows_coordinates_share_one_cutoff() -> None:
    rows = OneEuro(MIN_CUTOFF_HZ, BETA)
    flat = OneEuro(MIN_CUTOFF_HZ, BETA)
    jitter = 0.5

    for step in range(40):
        t_ms = step * FRAME_MS
        # x sweeps fast, y only wobbles.
        y = jitter * (-1.0) ** step
        row = rows(np.array([[20.0 * step, y]]), t_ms)
        column = flat(np.array([y]), t_ms)

    # The fast x raises the cutoff of its own row, so y follows its wobble more closely.
    assert abs(float(row[0][1]) - y) < abs(float(column[0]) - y)
