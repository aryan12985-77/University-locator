"""Occupancy collection primitives for Campus Navigator."""

from .base import OccupancyObservation, OccupancySource, build_observation
from .demo_source import DemoOccupancySource
from .manual_source import ManualOccupancySource

__all__ = [
    "DemoOccupancySource",
    "ManualOccupancySource",
    "OccupancyObservation",
    "OccupancySource",
    "build_observation",
]
