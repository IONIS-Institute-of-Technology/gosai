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

MODELS_DIR = Path(__file__).resolve().parent / "slr_models"

SEQUENCE_LENGTH = 30
# Face landmark indices used by the 158-feature models (legacy ``face_lm_ind``).
FACE_LM_IND = (10, 152, 234, 454)


def _flatten_xy(landmarks: list[list[float]] | None, count: int) -> list[float]:
    """Flatten landmarks to ``[x0, y0, x1, y1, ...]``, zero-padded to ``count``."""
    if landmarks:
        return [coord for lm in landmarks for coord in (float(lm[0]), float(lm[1]))]
    return [0.0] * (count * 2)


def _adapt_frame(frame: dict[str, Any], include_face: bool) -> list[float]:
    """Build one model input frame from a pose ``raw_data`` payload."""
    feats: list[float] = []
    if include_face:
        face = frame.get("face_mesh") or []
        for idx in FACE_LM_IND:
            if idx < len(face) and face[idx]:
                feats.extend((float(face[idx][0]), float(face[idx][1])))
            else:
                feats.extend((0.0, 0.0))
    feats.extend(_flatten_xy(frame.get("body_pose"), 33))
    feats.extend(_flatten_xy(frame.get("right_hand_pose"), 21))
    feats.extend(_flatten_xy(frame.get("left_hand_pose"), 21))
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
            import onnxruntime as ort
        except ImportError as exc:
            self.log("error", f"slr: onnxruntime/numpy unavailable: {exc}")
            return False

        model_path = MODELS_DIR / f"slr_{len(actions)}.onnx"
        if not model_path.exists():
            self.log("error", f"slr: no model for {len(actions)} actions ({model_path.name})")
            return False
        try:
            session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
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
