from collections import Counter

import pytest

from gosai_train.pipelines.yolo_detect.prepare import _expand_boxes
from gosai_train.pipelines.yolo_detect.sources import assign_split, classify_name, to_bbox_line


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("ball", "keep"),
        ("Cue-Ball", "keep"),
        ("cueball", "keep"),
        ("billiard_balls", "keep"),
        ("8", "keep"),
        ("Yellow", "keep"),
        ("ball in pocket", "drop"),
        ("pocket", "drop"),
        ("cue stick", "drop"),
        ("Person", "drop"),
        ("-", "unknown"),
        ("", "unknown"),
        ("Roboflow is an end-to-end computer vision platform that helps you", "unknown"),
    ],
)
def test_classify_name(name: str, expected: str) -> None:
    assert classify_name(name) == expected


def test_to_bbox_line_forces_class_zero() -> None:
    assert to_bbox_line(["3", "0.5", "0.25", "0.1", "0.2"]) == "0 0.500000 0.250000 0.100000 0.200000"


def test_to_bbox_line_converts_polygon_to_enclosing_box() -> None:
    polygon = ["1", "0.1", "0.2", "0.5", "0.2", "0.5", "0.6", "0.1", "0.6"]
    assert to_bbox_line(polygon) == "0 0.300000 0.400000 0.400000 0.400000"


@pytest.mark.parametrize(
    "parts",
    [
        ["0", "0.5", "0.5", "0.0", "0.2"],  # zero width
        ["0", "0.5", "0.5", "0.2", "-0.1"],  # negative height
        ["0", "0.1", "0.2", "0.3", "0.4", "0.5"],  # odd coordinate count
        ["0", "0.5", "0.5", "wide", "0.2"],  # not a number
    ],
)
def test_to_bbox_line_rejects_bad_rows(parts: list[str]) -> None:
    assert to_bbox_line(parts) is None


def test_expand_boxes_grows_along_blur_axis() -> None:
    horizontal = _expand_boxes(["0 0.5 0.5 0.2 0.2"], length=10, angle_deg=0.0, img_w=100, img_h=50)
    assert horizontal == ["0 0.500000 0.500000 0.300000 0.200000"]

    vertical = _expand_boxes(["0 0.5 0.5 0.2 0.2"], length=10, angle_deg=90.0, img_w=100, img_h=50)
    assert vertical == ["0 0.500000 0.500000 0.200000 0.400000"]


def test_expand_boxes_clamps_to_image() -> None:
    out = _expand_boxes(["0 0.05 0.5 0.1 0.1"], length=20, angle_deg=0.0, img_w=100, img_h=100)
    assert out == ["0 0.100000 0.500000 0.200000 0.100000"]


def test_assign_split_is_deterministic_and_roughly_80_10_10() -> None:
    keys = [f"custom/clip{i:04d}" for i in range(2000)]
    splits = [assign_split(key) for key in keys]
    assert splits == [assign_split(key) for key in keys]

    counts = Counter(splits)
    assert set(counts) == {"train", "val", "test"}
    assert 0.75 < counts["train"] / len(keys) < 0.85
    assert 0.07 < counts["val"] / len(keys) < 0.13
    assert 0.07 < counts["test"] / len(keys) < 0.13
