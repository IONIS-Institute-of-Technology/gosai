"""Smoke test: the bridge module imports and exposes the expected entry point."""

from __future__ import annotations


def test_bridge_imports() -> None:
    from gosai_py.bridge import Bridge, main

    assert callable(main)
    bridge = Bridge()
    assert bridge is not None


def test_version() -> None:
    from gosai_py import __version__

    assert isinstance(__version__, str)
    assert __version__.count(".") == 2
