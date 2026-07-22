"""Sign-language recognition (SLR) driver.

Classifies a short sequence of body/hand/face landmarks into a sign label using
the legacy ONNX models (``slr_16`` / ``slr_17``). It subscribes to the `pose`
driver's ``raw_data``, keeps a rolling 30-frame window, and emits ``new_sign``
once the window is full.

This is a direct port of the legacy ``slr`` driver and its ``get_sign`` utility.
The model is selected by the number of actions the app registers via the
``set_actions`` action (``slr_<num_actions>.onnx``). The per-frame feature
vector layout matches the model's expected input dimension:

- ``158`` features: ``face(4 landmarks) + body(33) + right_hand(21) +
  left_hand(21)`` flattened as ``(x, y)`` pairs.
- ``150`` features: same but without the face block.

Emitted event ``new_sign``: ``{ "guessed_sign": str, "probability": float }``.
"""

from __future__ import annotations

import time
from collections import deque
from pathlib import Path
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor
from gosai_py.runtime import create_onnx_session

MODELS_DIR = Path(__file__).resolve().parent / "slr_models"

SEQUENCE_LENGTH = 30
# Face landmark indices used by the 158-feature models (legacy ``face_lm_ind``).
FACE_LM_IND = (10, 152, 234, 454)

# The ONNX models were trained on raw pixel coordinates from the legacy
# 640x480 RealSense camera. Live landmarks (which arrive in the actual camera
# frame's pixel space) must be mapped into this space or the input distribution
# is off and recognition fails. The mapping is aspect-preserving (uniform
# scale, letterboxed/centered): stretching each axis independently squashes
# body proportions on any camera whose aspect differs from 4:3 -- a portrait
# camera would compress y by ~2.7x relative to x, which the models classify as
# noise. On a 640x480 camera the mapping is the identity, matching the legacy
# behaviour exactly.
TRAIN_WIDTH = 640.0
TRAIN_HEIGHT = 480.0


def _train_space_transform(frame_w: float, frame_h: float) -> tuple[float, float, float]:
    """Uniform scale + centering offsets mapping a frame into 640x480."""
    scale = min(TRAIN_WIDTH / max(frame_w, 1.0), TRAIN_HEIGHT / max(frame_h, 1.0))
    ox = (TRAIN_WIDTH - frame_w * scale) / 2.0
    oy = (TRAIN_HEIGHT - frame_h * scale) / 2.0
    return scale, ox, oy


def _flatten_xy(
    landmarks: list[list[float]] | None, count: int, s: float, ox: float, oy: float
) -> list[float]:
    """Flatten landmarks to ``[x0, y0, x1, y1, ...]`` mapped, zero-padded to ``count``.

    Absent parts stay all-zero (the models were trained with zero padding for
    missing hands), so the offsets apply only to present landmarks.
    """
    if landmarks:
        return [
            coord
            for lm in landmarks
            for coord in (float(lm[0]) * s + ox, float(lm[1]) * s + oy)
        ]
    return [0.0] * (count * 2)


def _adapt_frame(frame: dict[str, Any], include_face: bool) -> list[float]:
    """Build one model input frame from a pose ``raw_data`` payload.

    Landmarks are mapped from the live camera frame's pixel space into the
    legacy 640x480 training space, preserving aspect ratio (uniform scale,
    centered).
    """
    frame_w = float(frame.get("frame_width") or TRAIN_WIDTH)
    frame_h = float(frame.get("frame_height") or TRAIN_HEIGHT)
    s, ox, oy = _train_space_transform(frame_w, frame_h)

    feats: list[float] = []
    if include_face:
        face = frame.get("face_mesh") or []
        for idx in FACE_LM_IND:
            if idx < len(face) and face[idx]:
                feats.extend((float(face[idx][0]) * s + ox, float(face[idx][1]) * s + oy))
            else:
                feats.extend((0.0, 0.0))
    feats.extend(_flatten_xy(frame.get("body_pose"), 33, s, ox, oy))
    feats.extend(_flatten_xy(frame.get("right_hand_pose"), 21, s, ox, oy))
    feats.extend(_flatten_xy(frame.get("left_hand_pose"), 21, s, ox, oy))
    return feats


class SLRDriver(BaseProcessor):
    """Sign-language recognition over a rolling window of pose frames."""

    name: ClassVar[str] = "slr"
    description: ClassVar[str] = "Sign-language recognition from pose sequences (ONNX)."
    events: ClassVar[tuple[str, ...]] = ("new_sign",)
    actions: ClassVar[tuple[str, ...]] = ("set_actions",)
    dependencies: ClassVar[tuple[str, ...]] = ("pose",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("pose", "raw_data"),)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._session: Any = None
        self._input_name: str = "input"
        self._include_face: bool = True
        self._actions: list[str] = []
        self._frames: deque[list[float]] = deque(maxlen=SEQUENCE_LENGTH)

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_actions":
            if not isinstance(data, list) or not all(isinstance(a, str) for a in data):
                self.log("warn", "set_actions expects a list of strings")
                return {"ok": False}
            return {"ok": self._load_model(data)}
        return super().execute(action, data)

    def _load_model(self, actions: list[str]) -> bool:
        try:
            import numpy as np  # noqa: F401  (used in on_data)
        except ImportError as exc:
            self.log("error", f"slr: numpy unavailable: {exc}")
            return False

        model_path = MODELS_DIR / f"slr_{len(actions)}.onnx"
        if not model_path.exists():
            self.log("error", f"slr: no model for {len(actions)} actions ({model_path.name})")
            return False
        try:
            session, info = create_onnx_session(
                model_path,
                model_name=model_path.name,
                log_fn=self.log,
            )
        except Exception as exc:
            self.log("error", f"slr: failed to load {model_path.name}: {exc!r}")
            return False

        inp = session.get_inputs()[0]
        feature_dim = int(inp.shape[2]) if len(inp.shape) >= 3 and isinstance(inp.shape[2], int) else 158
        self._session = session
        self._input_name = inp.name
        self._include_face = feature_dim >= 158
        self._actions = list(actions)
        self._frames.clear()
        self.set_runtime_info(info)
        self.publish_state("running")
        self.log("info", f"slr: loaded {model_path.name} (features={feature_dim}, actions={len(actions)})")
        return True

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self._session is None or not isinstance(data, dict):
            return
        if not (data.get("body_pose") or data.get("right_hand_pose") or data.get("left_hand_pose")):
            return

        self._frames.append(_adapt_frame(data, self._include_face))
        if len(self._frames) < SEQUENCE_LENGTH:
            return

        import numpy as np

        sequence = np.array([list(self._frames)], dtype=np.float32)
        start = time.perf_counter()
        out = self._session.run(None, {self._input_name: sequence})[-1]
        self.record("inference_ms", (time.perf_counter() - start) * 1000.0)

        logits = np.asarray(out, dtype=np.float64).reshape(-1)
        probs = np.exp(logits - np.max(logits))
        probs /= np.sum(probs)
        idx = int(np.argmax(probs))
        guessed = self._actions[idx] if idx < len(self._actions) else "unknown"
        self.emit("new_sign", {"guessed_sign": guessed, "probability": float(probs[idx])})
