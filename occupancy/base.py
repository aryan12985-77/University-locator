"""Shared occupancy source and observation definitions."""

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


def parse_observed_at(value: Optional[str]) -> datetime:
    if not value:
        return datetime.now().replace(second=0, microsecond=0)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise ValueError("observed_at must be an ISO-8601 timestamp") from error
    if parsed.tzinfo:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed.replace(second=0, microsecond=0)


@dataclass(frozen=True)
class OccupancyObservation:
    campus_id: int
    location_id: int
    observed_at: datetime
    total_capacity: int
    occupied_count: int
    data_source: str
    confidence: Optional[float]

    def as_record(self):
        available_count = self.total_capacity - self.occupied_count
        occupancy_percentage = (self.occupied_count / self.total_capacity) * 100
        return {
            "campus_id": self.campus_id,
            "location_id": self.location_id,
            "observed_at": self.observed_at.isoformat(timespec="minutes"),
            "observation_date": self.observed_at.date().isoformat(),
            "day_of_week": self.observed_at.weekday(),
            "hour": self.observed_at.hour,
            "minute": self.observed_at.minute,
            "time_slot": self.observed_at.strftime("%H:%M"),
            "total_capacity": self.total_capacity,
            "occupied_count": self.occupied_count,
            "available_count": available_count,
            "occupancy_percentage": round(occupancy_percentage, 2),
            "data_source": self.data_source,
            "confidence": self.confidence,
        }


class OccupancySource:
    """Interface implemented by manual, synthetic, and future sensor sources."""

    name = "unknown"

    def observe(self, campus_id, location_id, capacity, occupied, **kwargs):
        raise NotImplementedError


def build_observation(
    campus_id,
    location_id,
    capacity,
    occupied,
    data_source,
    confidence=None,
    observed_at=None,
):
    try:
        total_capacity = int(capacity)
        occupied_count = int(occupied)
    except (TypeError, ValueError) as error:
        raise ValueError("capacity and occupied must be integers") from error
    if total_capacity <= 0:
        raise ValueError("capacity must be greater than zero")
    if occupied_count < 0 or occupied_count > total_capacity:
        raise ValueError("occupied must be between zero and capacity")
    if confidence is not None:
        try:
            confidence = float(confidence)
        except (TypeError, ValueError) as error:
            raise ValueError("confidence must be a number between 0 and 1") from error
        if not 0 <= confidence <= 1:
            raise ValueError("confidence must be a number between 0 and 1")
    return OccupancyObservation(
        campus_id=int(campus_id),
        location_id=int(location_id),
        observed_at=parse_observed_at(observed_at),
        total_capacity=total_capacity,
        occupied_count=occupied_count,
        data_source=data_source,
        confidence=confidence,
    )
