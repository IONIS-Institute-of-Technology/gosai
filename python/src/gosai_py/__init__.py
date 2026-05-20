"""GOSAI Python SDK and runtime.

Public surface:
- `gosai_py.bridge`: the long-running process that hosts drivers and
  communicates with the Node-side server over stdio JSON-lines.
- `gosai_py.driver.BaseDriver`: extend to implement a driver.
- `gosai_py.processor.BaseProcessor`: extend to implement an app's Python
  processor (consumes driver events, publishes derived events).
- `gosai_py.serialization`: helpers for serializing numpy frames and using
  MessagePack.
"""

from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.processor import BaseProcessor
from gosai_py.version import __version__

__all__ = [
    "BaseDriver",
    "BaseProcessor",
    "DriverContext",
    "__version__",
]
