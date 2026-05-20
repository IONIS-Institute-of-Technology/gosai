"""Calibration driver.

Detects ArUco markers in the camera frame and computes the homography between
the projection-space (the display where markers are drawn) and the
camera-space.

Events:
- `detection`: { detected, ids, corners } - latest marker observation.
- `homography`: { matrix: number[9] | null } - the most recent
  camera-to-display homography (3x3 row-major flattened) or `null`.
- `status`: { stage, message } - human-readable progress.

Actions:
- `set_marker_layout`: list of `{ id, x, y, size }` in display pixels.
- `set_camera_event`: change which `(driver, event)` carries the camera frame
  (defaults to ("camera", "color")).
- `compute`: aggregate the most recent detections and compute homography.
- `clear`: reset accumulated detections.
"""

from __future__ import annotations

import base64
import contextlib
import time
from collections.abc import Callable
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext


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
        "capture_background",
        "get_latest_frame",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    loop_interval_s: ClassVar[float | None] = None  # callback driven

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._camera_driver = "camera"
        self._camera_event = "color"
        self._marker_layout: list[dict[str, float]] = []
        self._last_detections: dict[int, tuple[float, float]] = {}
        self._sub_callback: Callable[[Any], None] | None = None
        self._latest_frame_b64: str | None = None
        self._latest_frame_meta: dict[str, Any] | None = None

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
        encoded = data.get("jpeg_base64")
        if not isinstance(encoded, str):
            return
        # Cache the latest frame so `capture_background` / `get_latest_frame`
        # can return it without re-asking the camera driver synchronously.
        self._latest_frame_b64 = encoded
        self._latest_frame_meta = {
            "width": data.get("width"),
            "height": data.get("height"),
            "ts": data.get("ts"),
        }
        try:
            self._detect(encoded)
        except Exception as exc:
            self.log("error", f"detection failed: {exc!r}")

    def _detect(self, jpeg_base64: str) -> None:
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv/numpy required: {exc}")
            return

        img_bytes = base64.b64decode(jpeg_base64)
        arr = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return

        if hasattr(cv2.aruco, "DICT_4X4_50"):
            aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        else:
            aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        params = (
            cv2.aruco.DetectorParameters()
            if hasattr(cv2.aruco, "DetectorParameters")
            else cv2.aruco.DetectorParameters_create()
        )

        if hasattr(cv2.aruco, "ArucoDetector"):
            detector = cv2.aruco.ArucoDetector(aruco_dict, params)
            corners, ids, _ = detector.detectMarkers(frame)
        else:
            corners, ids, _ = cv2.aruco.detectMarkers(frame, aruco_dict, parameters=params)

        if ids is None or len(ids) == 0:
            self.emit("detection", {"detected": 0, "ids": [], "corners": []})
            return

        ids_flat: list[int] = [int(i) for i in ids.flatten().tolist()]
        corners_list: list[list[list[float]]] = []
        for c in corners:
            arr_c = c.reshape(-1, 2).tolist()
            corners_list.append([[float(p[0]), float(p[1])] for p in arr_c])
            # Store centroid for later homography computation.
            cx = sum(p[0] for p in arr_c) / len(arr_c)
            cy = sum(p[1] for p in arr_c) / len(arr_c)
            self._last_detections[int(ids_flat[len(corners_list) - 1])] = (cx, cy)

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
            return self._compute_homography()

        if action == "clear":
            self._last_detections.clear()
            self.emit("status", {"stage": "cleared", "message": "accumulated detections cleared"})
            return {"ok": True}

        if action == "render_marker":
            marker_id = int(data.get("id", 0)) if isinstance(data, dict) else int(data)
            size = int(data.get("size", 200)) if isinstance(data, dict) else 200
            return self._render_marker(marker_id, size)

        if action == "capture_background":
            return self._capture_background()

        if action == "get_latest_frame":
            return self._get_latest_frame()

        return super().execute(action, data)

    def _capture_background(self) -> dict[str, Any]:
        if self._latest_frame_b64 is None:
            return {"ok": False, "error": "no camera frame received yet"}
        payload: dict[str, Any] = {
            "ok": True,
            "jpeg_base64": self._latest_frame_b64,
        }
        if self._latest_frame_meta is not None:
            payload.update({k: v for k, v in self._latest_frame_meta.items() if v is not None})
        return payload

    def _get_latest_frame(self) -> dict[str, Any]:
        return self._capture_background()

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

        if hasattr(cv2.aruco, "getPredefinedDictionary"):
            aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        else:
            aruco_dict = cv2.aruco.Dictionary_get(cv2.aruco.DICT_4X4_50)

        if hasattr(cv2.aruco, "generateImageMarker"):
            img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, size)
        else:
            img = cv2.aruco.drawMarker(aruco_dict, marker_id, size)

        ok, buf = cv2.imencode(".png", img)
        if not ok:
            return {"ok": False, "error": "imencode failed"}
        png_b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        return {"ok": True, "id": marker_id, "size": size, "png_base64": png_b64}

    def _compute_homography(self) -> dict[str, Any]:
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"opencv/numpy required: {exc}"}

        if len(self._marker_layout) < 4:
            return {"ok": False, "error": "need at least 4 markers in layout"}

        display_pts = []
        camera_pts = []
        for m in self._marker_layout:
            mid = int(m["id"])
            if mid not in self._last_detections:
                continue
            cx, cy = self._last_detections[mid]
            display_pts.append([m["x"], m["y"]])
            camera_pts.append([cx, cy])

        if len(display_pts) < 4:
            return {
                "ok": False,
                "error": f"only {len(display_pts)} markers detected, need 4",
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
        h_inv /= h_inv[2, 2]  # normalise

        flat = [float(v) for v in h_matrix.flatten().tolist()]
        flat_inv = [float(v) for v in h_inv.flatten().tolist()]

        self.emit("homography", {"matrix": flat, "inverse": flat_inv, "ts": time.time()})
        self.emit(
            "status",
            {
                "stage": "computed",
                "message": (
                    f"homography from {inlier_count}/{len(display_pts)} markers, "
                    f"reproj error {mean_err:.2f}px mean / {max_err:.2f}px max"
                ),
            },
        )
        return {
            "ok": True,
            "matrix": flat,
            "inverse": flat_inv,
            "samples": len(display_pts),
            "inliers": inlier_count,
            "reprojection_error_mean": round(mean_err, 3),
            "reprojection_error_max": round(max_err, 3),
        }
