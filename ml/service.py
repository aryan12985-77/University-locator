"""Training and prediction orchestration, independent of Flask."""

import sqlite3

from .features import FEATURE_NAMES, engineer_features, target_value
from .metrics import regression_metrics
from .models import SeasonalMeanModel, optional_second_model
from .registry import ModelRegistry
from .split import chronological_split


class InsufficientDataError(ValueError):
    """Raised when a trustworthy chronological evaluation is impossible."""


class PredictionService:
    def __init__(self, registry=None, minimum_observations=10):
        self.registry = registry
        self.minimum_observations = minimum_observations
        self.model = None
        self.model_name = None

    def train(self, observations):
        rows = list(observations)
        if len(rows) < self.minimum_observations:
            raise InsufficientDataError(
                f"need at least {self.minimum_observations} observations; got {len(rows)}"
            )
        split = chronological_split(rows)
        if not split.validation or not split.test:
            raise InsufficientDataError("need non-empty train, validation, and test partitions")
        baseline = SeasonalMeanModel().fit(split.train)
        validation_actual = [target_value(row) for row in split.validation]
        validation_predicted = baseline.predict(split.validation)
        candidates = [(baseline, regression_metrics(validation_actual, validation_predicted))]
        second = optional_second_model()
        if second is not None:
            x_train = [[engineer_features(row)[name] for name in FEATURE_NAMES] for row in split.train]
            second.fit(x_train, [target_value(row) for row in split.train])
            x_valid = [[engineer_features(row)[name] for name in FEATURE_NAMES] for row in split.validation]
            candidates.append((second, regression_metrics(validation_actual, second.predict(x_valid))))
        self.model, validation_metrics = min(candidates, key=lambda item: item[1]["mae"])
        self.model_name = getattr(self.model, "name", self.model.__class__.__name__)
        test_actual = [target_value(row) for row in split.test]
        test_predictions = self.predict_many(split.test)
        metadata = {
            "model": self.model_name,
            "features": list(FEATURE_NAMES),
            "observation_count": len(rows),
            "split_counts": {"train": len(split.train), "validation": len(split.validation), "test": len(split.test)},
            "validation_metrics": validation_metrics,
            "test_metrics": regression_metrics(test_actual, test_predictions),
        }
        if self.registry:
            metadata = self.registry.save(self.model, metadata)
        return metadata

    @staticmethod
    def load_observations(database_path, campus_id, location_id=None):
        """Load labeled occupancy rows from the Phase 1/2 SQLite table."""
        connection = sqlite3.connect(database_path)
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT campus_id, location_id, observed_at, total_capacity,
                   occupied_count, occupancy_percentage, data_source
            FROM occupancy_observations
            WHERE campus_id = ? AND (? IS NULL OR location_id = ?)
            ORDER BY observed_at ASC, id ASC
            """,
            (campus_id, location_id, location_id),
        ).fetchall()
        connection.close()
        return [dict(row) for row in rows]

    def predict_one(self, observation):
        if self.model is None:
            raise RuntimeError("train a model before predicting")
        if self.model_name == "seasonal_mean":
            value = self.model.predict_one(observation)
        else:
            vector = [[engineer_features(observation)[name] for name in FEATURE_NAMES]]
            value = self.model.predict(vector)[0]
        return max(0.0, min(100.0, float(value)))

    def predict_many(self, observations):
        return [self.predict_one(row) for row in observations]
