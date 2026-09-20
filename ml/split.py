"""Time-ordered dataset splitting (never shuffles future observations backwards)."""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class ChronologicalSplit:
    train: tuple
    validation: tuple
    test: tuple

    def __iter__(self):
        return iter((self.train, self.validation, self.test))


def _key(row):
    value = row["observed_at"]
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(
        tzinfo=None
    )


def chronological_split(observations, train_ratio=0.6, validation_ratio=0.2):
    """Sort by observation time and return train/validation/test partitions."""
    rows = sorted(tuple(observations), key=_key)
    if not rows:
        raise ValueError("at least one observation is required")
    if not 0 < train_ratio < 1 or not 0 <= validation_ratio < 1:
        raise ValueError("split ratios must be between zero and one")
    if train_ratio + validation_ratio >= 1:
        raise ValueError("train and validation ratios must leave a test partition")
    train_end = max(1, int(len(rows) * train_ratio))
    validation_end = max(train_end + 1, int(len(rows) * (train_ratio + validation_ratio)))
    validation_end = min(validation_end, len(rows) - 1) if len(rows) > 1 else len(rows)
    return ChronologicalSplit(
        tuple(rows[:train_end]),
        tuple(rows[train_end:validation_end]),
        tuple(rows[validation_end:]),
    )
