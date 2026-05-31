"""Put the repo root on sys.path so tests can ``import nodes.*`` standalone.

This conftest lives in ``tests/`` (which has no ``__init__.py``) so pytest imports it
in isolation, without executing the package root ``__init__.py`` (the ComfyUI
entrypoint, which can't load outside ComfyUI).
"""

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(__file__))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
