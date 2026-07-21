from __future__ import annotations

from gosai_py.drivers.slr import FACE_LM_IND, _adapt_frame


def _payload(frame_w: float, frame_h: float) -> dict:
    face = [[float(i), float(i) + 0.5, 1.0] for i in range(478)]
    body = [[10.0 * i, 5.0 * i, 1.0] for i in range(33)]
    right = [[100.0 + i, 200.0 + i, 1.0] for i in range(21)]
    left = [[300.0 + i, 400.0 + i, 1.0] for i in range(21)]
    return {
        "face_mesh": face,
        "body_pose": body,
        "right_hand_pose": right,
        "left_hand_pose": left,
        "frame_width": frame_w,
        "frame_height": frame_h,
    }


def test_feature_layout_and_length() -> None:
    feats = _adapt_frame(_payload(640.0, 480.0), include_face=True)

    assert len(feats) == (4 + 33 + 21 + 21) * 2
    # Face block first, in FACE_LM_IND order, then body, right hand, left hand.
    assert feats[0:2] == [float(FACE_LM_IND[0]), FACE_LM_IND[0] + 0.5]
    body_start = 4 * 2
    assert feats[body_start : body_start + 2] == [0.0, 0.0]
    right_start = body_start + 33 * 2
    assert feats[right_start : right_start + 2] == [100.0, 200.0]
    left_start = right_start + 21 * 2
    assert feats[left_start : left_start + 2] == [300.0, 400.0]


def test_no_face_layout() -> None:
    feats = _adapt_frame(_payload(640.0, 480.0), include_face=False)

    assert len(feats) == (33 + 21 + 21) * 2
    assert feats[0:2] == [0.0, 0.0]  # body landmark 0.


def test_rescales_to_training_space() -> None:
    # A 1280x720 frame must be rescaled by (0.5, 2/3) into 640x480.
    feats = _adapt_frame(_payload(1280.0, 720.0), include_face=False)

    body_lm1_x, body_lm1_y = feats[2], feats[3]
    assert body_lm1_x == 10.0 * 0.5
    assert abs(body_lm1_y - 5.0 * (480.0 / 720.0)) < 1e-9


def test_missing_parts_are_zero_padded() -> None:
    payload = _payload(640.0, 480.0)
    payload["right_hand_pose"] = []
    payload["face_mesh"] = []
    feats = _adapt_frame(payload, include_face=True)

    assert len(feats) == (4 + 33 + 21 + 21) * 2
    assert feats[0:8] == [0.0] * 8  # face block zeroed.
    right_start = (4 + 33) * 2
    assert feats[right_start : right_start + 42] == [0.0] * 42


def test_missing_frame_size_defaults_to_training_space() -> None:
    payload = _payload(640.0, 480.0)
    del payload["frame_width"]
    del payload["frame_height"]
    feats = _adapt_frame(payload, include_face=False)

    assert feats[2:4] == [10.0, 5.0]  # unscaled.
