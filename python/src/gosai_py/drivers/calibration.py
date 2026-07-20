"""Calibration driver.

Detects ArUco markers in the camera frame and computes the homography between
the projection-space (the display where markers are drawn) and the
camera-space.

The driver produces **two** related homographies on `compute`:

- ``camera -> display``: classic camera-to-projector mapping. Uses **all 4
  corners** of every detected ArUco marker (not just centroids), giving
  4x more correspondences and dramatically improved accuracy near the edges
  where keystone distortion is worst.
- ``camera -> surface``: optional camera-to-surface mapping, computed when
  ``compute`` is called with a ``focus_quad`` (the 4 physical table corners
  in normalised camera coords) and a ``surface_size`` (the canonical reference
  resolution apps render in, defaults to 1920x1080). This is what tracking
  drivers (``ball``, ``hand_pose``) should consume so the coordinates they
  emit live directly in the apps' reference space, regardless of how the
  camera is angled.

Events:
- `detection`: { detected, ids, corners } - latest marker observation.
- `homography`: { matrix: number[9] | null, surface_matrix: number[9] | null }
  - the most recent matrices (3x3 row-major flattened) or null.
- `status`: { stage, message } - human-readable progress.

Actions:
- `set_marker_layout`: list of `{ id, x, y, size }` in display pixels.
- `set_camera_event`: change which `(driver, event)` carries the camera frame
  (defaults to ("camera", "frame")).
- `compute`: aggregate the most recent detections and compute homography.
  Accepts an optional dict ``{ focus_quad, surface_size, frame_size }`` to
  also compute the camera->surface homography.
- `clear`: reset accumulated detections.
- `render_marker`: { id, size } -> { ok, png_base64 } -- generate an ArUco
  marker PNG for the projector to display.
- `get_latest_frame`: return the latest cached frame.
- `reproject_point`: { x, y, space?: 'display'|'surface' } -> warped point.
- `reproject_points`: { points: [{x,y}], space?: 'display'|'surface' }.
"""

from __future__ import annotations

import base64
import contextlib
import time
from collections.abc import Callable
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.serialization import frame_to_jpeg_base64


class CalibrationDriver(BaseDriver):
    name: ClassVar[str] = "calibration"
    description: ClassVar[str] = "Camera-projector calibration via ArUco markers."
    events: ClassVar[tuple[str, ...]] = ("detection", "homography", "status")
    actions: ClassVar[tuple[str, ...]] = (
        "set_marker_layout",
        "set_camera_event",
        "compute",
        "clear",
        "render_marker",
        "get_latest_frame",
        "reproject_point",
        "reproject_points",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    loop_interval_s: ClassVar[float | None] = None  # callback driven

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._camera_driver = "camera"
        self._camera_event = "frame"
        self._marker_layout: list[dict[str, float]] = []
        # 4 corners per detected marker, in TL,TR,BR,BL order matching the
        # marker's own coordinate system (same convention as cv2.aruco).
        self._last_detections: dict[int, list[tuple[float, float]]] = {}
        self._sub_callback: Callable[[Any], None] | None = None
        self._latest_frame_b64: str | None = None
        self._latest_frame: Any = None
        self._latest_frame_meta: dict[str, Any] | None = None
        # Last computed matrices, kept so reproject_point can run without
        # re-deriving them. ``None`` until compute succeeds.
        self._homography: Any = None  # ndarray (3, 3) camera->display
        self._homography_surface: Any = None  # ndarray (3, 3) camera->surface

    def pre_run(self) -> None:
        self._subscribe()

    def cleanup(self) -> None:
        self._unsubscribe()

    # ------------------------------------------------------------------
    # Subscription management
    # ------------------------------------------------------------------

    def _subscribe(self) -> None:
        cb = self._on_frame
        self._sub_callback = cb
        self._context.subscribe(self._camera_driver, self._camera_event, cb)

    def _unsubscribe(self) -> None:
        if self._sub_callback is None:
            return
        with contextlib.suppress(Exception):
            self._context.unsubscribe(self._camera_driver, self._camera_event, self._sub_callback)
        self._sub_callback = None

    # ------------------------------------------------------------------
    # Frame handling
    # ------------------------------------------------------------------

    def _on_frame(self, data: Any) -> None:
        if not isinstance(data, dict):
            return
        frame = data.get("_frame")
        encoded = data.get("jpeg_base64")
        if frame is None and not isinstance(encoded, str):
            return
        # Cache the latest frame so `get_latest_frame` can return it without
        # re-asking the camera driver synchronously. Raw frames avoid Python-side
        # JPEG encode/decode during detection.
        self._latest_frame = frame.copy() if frame is not None and hasattr(frame, "copy") else frame
        self._latest_frame_b64 = encoded if isinstance(encoded, str) else None
        self._latest_frame_meta = {
            "width": data.get("width"),
            "height": data.get("height"),
            "ts": data.get("ts"),
        }
        try:
            if frame is not None:
                self._detect(frame)
            elif isinstance(encoded, str):
                self._detect_encoded(encoded)
        except Exception as exc:
            self.log("error", f"detection failed: {exc!r}")

    def _detect_encoded(self, jpeg_base64: str) -> None:
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv/numpy required: {exc}")
            return

        img_bytes = base64.b64decode(jpeg_base64)
        arr = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is not None:
            self._detect(frame)

    def _detect(self, frame: Any) -> None:
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv required: {exc}")
            return

        aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        params = cv2.aruco.DetectorParameters()
        detector = cv2.aruco.ArucoDetector(aruco_dict, params)
        corners, ids, _ = detector.detectMarkers(frame)

        if ids is None or len(ids) == 0:
            self.emit("detection", {"detected": 0, "ids": [], "corners": []})
            return

        ids_flat: list[int] = [int(i) for i in ids.flatten().tolist()]
        corners_list: list[list[list[float]]] = []
        for idx, c in enumerate(corners):
            arr_c = c.reshape(-1, 2).tolist()
            pts = [(float(p[0]), float(p[1])) for p in arr_c]
            corners_list.append([[p[0], p[1]] for p in pts])
            # Store all 4 corners (TL, TR, BR, BL) keyed by marker id so the
            # homography compute step can build 4x as many correspondences
            # as the legacy centroid-only version.
            self._last_detections[int(ids_flat[idx])] = pts

        self.emit(
            "detection",
            {"detected": len(ids_flat), "ids": ids_flat, "corners": corners_list, "ts": time.time()},
        )

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_marker_layout":
            if not isinstance(data, list):
                raise ValueError("marker_layout must be a list of {id, x, y, size}")
            self._marker_layout = [self._validate_marker(m) for m in data]
            self._last_detections.clear()
            self.emit("status", {"stage": "configured", "message": f"layout with {len(self._marker_layout)} markers"})
            return {"count": len(self._marker_layout)}

        if action == "set_camera_event":
            self._unsubscribe()
            if isinstance(data, dict):
                self._camera_driver = str(data.get("driver", self._camera_driver))
                self._camera_event = str(data.get("event", self._camera_event))
            self._subscribe()
            return {"driver": self._camera_driver, "event": self._camera_event}

        if action == "compute":
            return self._compute_homography(data)

        if action == "clear":
            self._last_detections.clear()
            self.emit("status", {"stage": "cleared", "message": "accumulated detections cleared"})
            return {"ok": True}

        if action == "render_marker":
            marker_id = int(data.get("id", 0)) if isinstance(data, dict) else int(data)
            size = int(data.get("size", 200)) if isinstance(data, dict) else 200
            return self._render_marker(marker_id, size)

        if action == "get_latest_frame":
            return self._get_latest_frame()

        if action == "reproject_point":
            return self._reproject_point(data)

        if action == "reproject_points":
            return self._reproject_points(data)

        return super().execute(action, data)

    def _get_latest_frame(self) -> dict[str, Any]:
        if self._latest_frame_b64 is None and self._latest_frame is None:
            return {"ok": False, "error": "no camera frame received yet"}
        if self._latest_frame_b64 is None:
            self._latest_frame_b64 = frame_to_jpeg_base64(self._latest_frame, quality=75)
        payload: dict[str, Any] = {
            "ok": True,
            "jpeg_base64": self._latest_frame_b64,
        }
        if self._latest_frame_meta is not None:
            payload.update({k: v for k, v in self._latest_frame_meta.items() if v is not None})
        return payload

    def _validate_marker(self, m: dict[str, Any]) -> dict[str, float]:
        for key in ("id", "x", "y"):
            if key not in m:
                raise ValueError(f"marker missing key {key!r}")
        return {
            "id": float(m["id"]),
            "x": float(m["x"]),
            "y": float(m["y"]),
            "size": float(m.get("size", 60)),
        }

    def _render_marker(self, marker_id: int, size: int) -> dict[str, Any]:
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"opencv required: {exc}"}

        aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, size)

        ok, buf = cv2.imencode(".png", img)
        if not ok:
            return {"ok": False, "error": "imencode failed"}
        png_b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        return {"ok": True, "id": marker_id, "size": size, "png_base64": png_b64}

    def _compute_homography(self, params: Any = None) -> dict[str, Any]:
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"opencv/numpy required: {exc}"}

        if len(self._marker_layout) < 4:
            return {"ok": False, "error": "need at least 4 markers in layout"}

        # ------------------------------------------------------------------
        # Parse optional params: focus_quad (4 normalised camera points),
        # surface_size (target reference resolution), frame_size (camera
        # frame in pixels). When all three are present, we also compute the
        # camera->surface homography.
        # ------------------------------------------------------------------
        focus_quad_norm: list[tuple[float, float]] | None = None
        surface_w = 1920
        surface_h = 1080
        frame_w: int | None = None
        frame_h: int | None = None
        if isinstance(params, dict):
            fq = params.get("focus_quad")
            if isinstance(fq, list) and len(fq) == 4:
                try:
                    focus_quad_norm = [
                        (float(_get_xy(p, 0)), float(_get_xy(p, 1))) for p in fq
                    ]
                except (TypeError, ValueError):
                    focus_quad_norm = None
            ss = params.get("surface_size")
            if isinstance(ss, dict):
                surface_w = int(ss.get("width", surface_w))
                surface_h = int(ss.get("height", surface_h))
            fs = params.get("frame_size")
            if isinstance(fs, dict):
                frame_w = int(fs.get("width", 0)) or None
                frame_h = int(fs.get("height", 0)) or None
        # Fall back to the last seen frame size for normalisation if the caller
        # did not supply one explicitly.
        if (frame_w is None or frame_h is None) and self._latest_frame_meta is not None:
            frame_w = frame_w or int(self._latest_frame_meta.get("width") or 0) or None
            frame_h = frame_h or int(self._latest_frame_meta.get("height") or 0) or None

        # ------------------------------------------------------------------
        # Build per-corner correspondences. For each detected marker we have
        # 4 corners (TL, TR, BR, BL); we pair them with the corresponding
        # corners of the projected marker in display space, computed from
        # the layout's {x, y, size}.
        # ------------------------------------------------------------------
        display_pts: list[list[float]] = []
        camera_pts: list[list[float]] = []
        detected_markers = 0
        for m in self._marker_layout:
            mid = int(m["id"])
            cam_corners = self._last_detections.get(mid)
            if cam_corners is None or len(cam_corners) != 4:
                continue
            disp_corners = _marker_display_corners(m)
            for (cx, cy), (dx, dy) in zip(cam_corners, disp_corners, strict=True):
                camera_pts.append([cx, cy])
                display_pts.append([dx, dy])
            detected_markers += 1

        if detected_markers < 4:
            return {
                "ok": False,
                "error": f"only {detected_markers} markers detected, need 4",
            }

        display_arr = np.array(display_pts, dtype=np.float64)
        camera_arr = np.array(camera_pts, dtype=np.float64)

        # Full projective (perspective) homography with RANSAC handles
        # keystone deformation from angled projectors and/or cameras.
        h_matrix, mask = cv2.findHomography(
            camera_arr,
            display_arr,
            method=cv2.RANSAC,
            ransacReprojThreshold=5.0,
        )
        if h_matrix is None:
            return {"ok": False, "error": "findHomography returned None"}

        inlier_count = int(mask.sum()) if mask is not None else len(display_pts)

        # Reprojection error (mean and max) over inliers.
        reprojected = cv2.perspectiveTransform(
            camera_arr.reshape(-1, 1, 2), h_matrix,
        ).reshape(-1, 2)
        errors = np.linalg.norm(reprojected - display_arr, axis=1)
        if mask is not None:
            inlier_mask = mask.ravel().astype(bool)
            inlier_errors = errors[inlier_mask]
        else:
            inlier_errors = errors
        mean_err = float(np.mean(inlier_errors)) if len(inlier_errors) > 0 else 0.0
        max_err = float(np.max(inlier_errors)) if len(inlier_errors) > 0 else 0.0

        # Inverse homography (display→camera) for downstream usage.
        h_inv = np.linalg.inv(h_matrix)
        h_inv /= h_inv[2, 2]

        self._homography = h_matrix
        flat = [float(v) for v in h_matrix.flatten().tolist()]
        flat_inv = [float(v) for v in h_inv.flatten().tolist()]

        # ------------------------------------------------------------------
        # Surface homography (camera -> reference space) and focus_quad
        # in display space (used by apps for CSS-based keystone correction).
        # ------------------------------------------------------------------
        surface_flat: list[float] | None = None
        surface_inv_flat: list[float] | None = None
        surface_quad_display: list[dict[str, float]] | None = None
        if focus_quad_norm is not None and frame_w and frame_h:
            quad_camera_px = np.array(
                [[u * frame_w, v * frame_h] for (u, v) in focus_quad_norm],
                dtype=np.float64,
            )
            surface_rect = np.array(
                [
                    [0.0, 0.0],
                    [float(surface_w), 0.0],
                    [float(surface_w), float(surface_h)],
                    [0.0, float(surface_h)],
                ],
                dtype=np.float64,
            )
            h_surface, _ = cv2.findHomography(quad_camera_px, surface_rect, method=0)
            if h_surface is not None:
                h_surface_inv = np.linalg.inv(h_surface)
                h_surface_inv /= h_surface_inv[2, 2]
                self._homography_surface = h_surface
                surface_flat = [float(v) for v in h_surface.flatten().tolist()]
                surface_inv_flat = [float(v) for v in h_surface_inv.flatten().tolist()]
                # Apply camera->display to the focus quad so apps know where
                # the physical surface lives in the projector's coordinate
                # frame (for CSS matrix3d keystone correction).
                quad_disp = cv2.perspectiveTransform(
                    quad_camera_px.reshape(-1, 1, 2), h_matrix,
                ).reshape(-1, 2)
                surface_quad_display = [
                    {"x": float(p[0]), "y": float(p[1])} for p in quad_disp.tolist()
                ]

        self.emit(
            "homography",
            {
                "matrix": flat,
                "inverse": flat_inv,
                "surface_matrix": surface_flat,
                "surface_inverse": surface_inv_flat,
                "ts": time.time(),
            },
        )
        self.emit(
            "status",
            {
                "stage": "computed",
                "message": (
                    f"homography from {detected_markers} markers "
                    f"({len(display_pts)} corner pairs, {inlier_count} inliers), "
                    f"reproj error {mean_err:.2f}px mean / {max_err:.2f}px max"
                ),
            },
        )
        return {
            "ok": True,
            "matrix": flat,
            "inverse": flat_inv,
            "surface_matrix": surface_flat,
            "surface_inverse": surface_inv_flat,
            "surface_quad_display": surface_quad_display,
            "surface_size": {"width": surface_w, "height": surface_h},
            "frame_size": (
                {"width": int(frame_w), "height": int(frame_h)}
                if frame_w and frame_h
                else None
            ),
            "samples": len(display_pts),
            "markers": detected_markers,
            "inliers": inlier_count,
            "reprojection_error_mean": round(mean_err, 3),
            "reprojection_error_max": round(max_err, 3),
        }

    def _reproject_point(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            return {"ok": False, "error": "expected { x, y, space? }"}
        try:
            x = float(data["x"])
            y = float(data["y"])
        except (KeyError, TypeError, ValueError):
            return {"ok": False, "error": "expected numeric x, y"}
        space = str(data.get("space", "display"))
        h = self._homography_surface if space == "surface" else self._homography
        if h is None:
            return {"ok": False, "error": f"homography for '{space}' not computed yet"}
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"opencv/numpy required: {exc}"}
        warped = cv2.perspectiveTransform(
            np.array([[[x, y]]], dtype=np.float64), h,
        ).reshape(-1, 2)
        return {"ok": True, "x": float(warped[0][0]), "y": float(warped[0][1])}

    def _reproject_points(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            return {"ok": False, "error": "expected { points: [...], space? }"}
        raw_points = data.get("points")
        if not isinstance(raw_points, list) or not raw_points:
            return {"ok": False, "error": "expected non-empty points list"}
        try:
            pts = [(float(_get_xy(p, 0)), float(_get_xy(p, 1))) for p in raw_points]
        except (KeyError, TypeError, ValueError):
            return {"ok": False, "error": "points must be [{x,y}] or [[x,y]]"}
        space = str(data.get("space", "display"))
        h = self._homography_surface if space == "surface" else self._homography
        if h is None:
            return {"ok": False, "error": f"homography for '{space}' not computed yet"}
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"opencv/numpy required: {exc}"}
        arr = np.array([[p] for p in pts], dtype=np.float64)
        warped = cv2.perspectiveTransform(arr, h).reshape(-1, 2)
        return {
            "ok": True,
            "points": [
                {"x": float(p[0]), "y": float(p[1])} for p in warped.tolist()
            ],
        }


def _get_xy(point: Any, axis: int) -> float:
    """Read x/y from either a `{x, y}` dict or `[x, y]` sequence."""
    if isinstance(point, dict):
        key = "x" if axis == 0 else "y"
        return float(point[key])
    if isinstance(point, (list, tuple)) and len(point) > axis:
        return float(point[axis])
    raise ValueError("point must be {x, y} or [x, y]")


def _marker_display_corners(m: dict[str, float]) -> list[tuple[float, float]]:
    """Return the 4 corners of a marker layout entry in TL, TR, BR, BL order
    (matching the cv2.aruco corner ordering convention)."""
    cx = float(m["x"])
    cy = float(m["y"])
    half = float(m.get("size", 60)) / 2.0
    return [
        (cx - half, cy - half),
        (cx + half, cy - half),
        (cx + half, cy + half),
        (cx - half, cy + half),
    ]
