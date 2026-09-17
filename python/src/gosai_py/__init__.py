"""GOSAI Python SDK and runtime.

Public surface:
- `gosai_py.bridge`: the long-running process that hosts drivers and
  communicates with the Node-side server over stdio JSON-lines.
- `gosai_py.driver.BaseDriver`: extend to implement a driver, declaring
  events with `Event` and actions with `@action`.
- `gosai_py.schemas`: the JSON Schema of a driver's config, events and actions.
- `gosai_py.serialization`: JPEG encoding for frames.
"""

from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.version import __version__

__all__ = [
    "BaseDriver",
    "DriverContext",
    "Event",
    "__version__",
    "action",
]
