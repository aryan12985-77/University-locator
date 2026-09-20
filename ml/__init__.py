"""Small, dependency-light occupancy forecasting core.

The package deliberately does not import Flask or change navigation routes.  It
can be used by a job, a CLI, or an API layer once enough observations exist.
"""

from .features import FEATURE_NAMES, engineer_features
from .metrics import regression_metrics
from .split import chronological_split
from .service import InsufficientDataError, PredictionService

__all__ = [
    "FEATURE_NAMES",
    "InsufficientDataError",
    "PredictionService",
    "chronological_split",
    "engineer_features",
    "regression_metrics",
]
