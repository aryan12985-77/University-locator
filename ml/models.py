"""Baseline and optional second model implementations."""

from collections import defaultdict
from .features import engineer_features, target_value


def _hour(row):
    value = row["observed_at"]
    return value[11:13] if isinstance(value, str) else value.strftime("%H")


class SeasonalMeanModel:
    """Interpretable location/hour/weekday mean with a global fallback."""

    name = "seasonal_mean"

    def fit(self, observations):
        groups = defaultdict(list)
        values = [target_value(row) for row in observations]
        if not values:
            raise ValueError("cannot train without observations")
        for row, value in zip(observations, values):
            features = engineer_features(row)
            groups[(int(features["location_id"]), _hour(row), int(features["is_weekend"]))].append(value)
        self.global_mean = sum(values) / len(values)
        self.groups = {key: sum(items) / len(items) for key, items in groups.items()}
        return self

    def predict_one(self, row):
        features = engineer_features(row)
        key = (int(features["location_id"]), _hour(row), int(features["is_weekend"]))
        return self.groups.get(key, self.global_mean)

    def predict(self, rows):
        return [self.predict_one(row) for row in rows]


def optional_second_model():
    """Return an sklearn model only when sklearn is already installed."""
    try:
        from sklearn.ensemble import HistGradientBoostingRegressor
    except ImportError:
        return None
    return HistGradientBoostingRegressor(max_iter=100, random_state=42)
