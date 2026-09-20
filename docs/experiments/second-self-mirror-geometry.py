"""Check the mirror model and quantify idealized error sources.

Run from the repository root:
    PYTHONPATH=python/src python/.venv/bin/python docs/experiments/second-self-mirror-geometry.py

All distances are millimeters. This is an optical geometry experiment, not a
measurement of the physical rig. It ignores refraction, lens distortion and
tracking noise. The general-plane calculation is independent of the shipped
projection, which is imported only for the comparison.
"""

import math

import numpy as np
from gosai_py.geometry import mirror_rig


def virtual_image(point, normal, offset):
    """Reflect a point through the plane normal.dot(X) = offset."""
    return point - 2 * (normal @ point - offset) * normal


def screen_hit(eye, point, mirror_normal, mirror_offset, screen_normal, screen_offset):
    reflected = virtual_image(point, mirror_normal, mirror_offset)
    direction = reflected - eye
    t = (screen_offset - screen_normal @ eye) / (screen_normal @ direction)
    return eye + t * direction


def flat_hit(eye, point, gap=0):
    normal = np.array([0.0, 0.0, 1.0])
    return screen_hit(eye, point, normal, 0, normal, -gap)


def main():
    rng = np.random.default_rng(7)
    worst = 0.0
    for tilt in (-25, 0, 17, 35):
        theta = math.radians(tilt)
        normal = np.array([0.0, -math.sin(theta), math.cos(theta)])
        vertical = np.array([0.0, math.cos(theta), math.sin(theta)])
        for offset in (0, 40):
            # A rig whose canvas plane is exactly normal.dot(X) = offset, with
            # the camera at the origin and no gap, so the canvas center is the
            # point of the plane nearest the camera. The screen's u axis runs
            # the viewer's way, against the camera's x, and v is `vertical`.
            rig = mirror_rig.Rig.nominal(600.0, 1000.0, 0.0, (0.0, 0.0, offset), tilt)
            for _ in range(100):
                eye = rng.uniform([-300, -300, 1200], [300, 300, 2400])
                point = rng.uniform([-500, -600, 800], [500, 1000, 2400])
                hit = screen_hit(eye, point, normal, offset, normal, offset)
                expected = np.array([-hit[0], vertical @ hit])
                actual = mirror_rig.project_mm(rig, eye, point)
                worst = max(worst, float(np.linalg.norm(actual - expected)))
    assert worst < 1e-9
    print(f"Rig projection vs independent plane intersection: max error {worst:.2e} mm")

    # The midpoint result only applies when eye and point have equal normal depth.
    for distance in (800, 1500, 2500):
        eye = np.array([0.0, 0.0, distance])
        point = np.array([300.0, 700.0, distance])
        np.testing.assert_allclose(flat_hit(eye, point), [150, 350, 0], atol=1e-10)
    print("Equal-depth midpoint invariant: passed at 0.8, 1.5 and 2.5 m")

    # General geometry also preserves distances to a tilted plane under reflection.
    normal = np.array([0.2, -0.3, 1.0])
    normal /= np.linalg.norm(normal)
    point = np.array([300.0, 700.0, 1100.0])
    reflected = virtual_image(point, normal, 50)
    np.testing.assert_allclose(normal @ reflected - 50, -(normal @ point - 50))
    np.testing.assert_allclose(virtual_image(reflected, normal, 50), point)
    print("General mirror plane: signed-distance and double-reflection checks passed")

    eye = np.array([0.0, 0.0, 1500.0])
    point = np.array([300.0, 700.0, 1500.0])
    accurate = flat_hit(eye, point)
    wrong_eye = flat_hit(eye + np.array([0, 60, 0]), point)
    print(
        f"60 mm vertical eye-position error: {np.linalg.norm(wrong_eye - accurate):.1f} mm on glass"
    )

    left = flat_hit(eye + np.array([-32, 0, 0]), point)
    right = flat_hit(eye + np.array([32, 0, 0]), point)
    separation = np.linalg.norm(left - right)
    np.testing.assert_allclose(separation, 32)
    print(f"64 mm eye separation: required screen points are {separation:.1f} mm apart")

    for distance in (800, 1500, 2500):
        e = np.array([0.0, 0.0, distance])
        p = np.array([300.0, 700.0, distance])
        for gap in (5, 10):
            delta = np.linalg.norm((flat_hit(e, p, gap=gap) - flat_hit(e, p))[:2])
            print(
                f"Ignoring {gap} mm screen gap at {distance / 1000:.1f} m: "
                f"{delta:.2f} mm lateral error"
            )

    # Fix the camera ray while changing inferred depth, as a monocular estimator does.
    near_hand = np.array([300.0, 700.0, 1100.0])
    wrong_depth_hand = near_hand * (1300 / 1100)
    depth_error = np.linalg.norm(flat_hit(eye, wrong_depth_hand) - flat_hit(eye, near_hand))
    print(f"Hand depth overestimated by 200 mm along its camera ray: {depth_error:.1f} mm error")

    # Steady constant-velocity lag of y[t] = alpha*x[t] + (1-alpha)*y[t-1].
    alpha, fps = 0.4, 30
    lag_ms = (1 - alpha) / alpha / fps * 1000
    print(f"Existing body smoother at 30 updates/s: {lag_ms:.1f} ms steady-ramp lag")
    print(f"At 500 mm/s screen-space motion: {500 * lag_ms / 1000:.1f} mm trailing error")


if __name__ == "__main__":
    main()
