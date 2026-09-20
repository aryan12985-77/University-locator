"""Deterministic, explainable features for occupancy observations."""

import math
from datetime import datetime

FEATURE_NAMES = (
    "location_id",
    "total_capacity",
    "hour_sin",
    "hour_cos",
    "weekday_sin",
    "weekday_cos",
    "is_weekend",
)


def _timestamp(row):
    value = row.get("observed_at")
    if isinstance(value, datetime):
        return value
    if not value:
        raise ValueError("each observation needs observed_at")
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(
        tzinfo=None
    )


def engineer_features(observation):
    """Return a fixed numeric feature mapping; no target leakage is included."""
    timestamp = _timestamp(observation)
    hour = timestamp.hour + timestamp.minute / 60.0
    weekday = timestamp.weekday()
    return {
        "location_id": float(observation["location_id"]),
        "total_capacity": float(observation["total_capacity"]),
        "hour_sin": math.sin(2 * math.pi * hour / 24),
        "hour_cos": math.cos(2 * math.pi * hour / 24),
        "weekday_sin": math.sin(2 * math.pi * weekday / 7),
        "weekday_cos": math.cos(2 * math.pi * weekday / 7),
        "is_weekend": float(weekday >= 5),
    }


def target_value(observation):
    """Read the percentage target, accepting raw counts when percentage is absent."""
    if observation.get("occupancy_percentage") is not None:
        return float(observation["occupancy_percentage"])
    capacity = float(observation["total_capacity"])
    if capacity <= 0:
        raise ValueError("total_capacity must be greater than zero")
    return 100.0 * float(observation["occupied_count"]) / capacity
