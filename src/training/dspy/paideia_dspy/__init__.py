"""A narrow, host-mediated bridge to the actual DSPy optimizer."""

from .optimizer import optimize
from .protocol import SCHEMA, BridgeError, OptimizeRequest

__all__ = ["SCHEMA", "BridgeError", "OptimizeRequest", "optimize"]
