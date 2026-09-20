"""Configurable synthetic occupancy data for development and API testing."""

from dataclasses import dataclass
from datetime import datetime, timedelta
import math
import random

from .base import OccupancySource, build_observation


@dataclass(frozen=True)
class FacilityPattern:
    """Synthetic pattern parameters for one facility category."""

    base_rate: float
    peak_hours: tuple
    peak_width: float
    weekend_rate: float
    noise: float


FACILITY_PATTERNS = {
    "library": FacilityPattern(0.12, (10, 14, 17), 2.4, 0.55, 0.04),
    "reading_room": FacilityPattern(0.18, (11, 15, 18), 2.0, 0.65, 0.035),
    "lab": FacilityPattern(0.08, (10, 14, 16), 1.7, 0.35, 0.035),
    "classroom": FacilityPattern(0.05, (9, 12, 15), 1.2, 0.2, 0.025),
    "canteen": FacilityPattern(0.08, (9, 13, 19), 1.0, 0.7, 0.04),
    "sports": FacilityPattern(0.05, (7, 17, 19), 1.8, 0.55, 0.035),
    "default": FacilityPattern(0.08, (11, 14, 17), 2.2, 0.4, 0.04),
}


def facility_category(name="", building="", facility_type=""):
    value = " ".join((name, building, facility_type)).casefold()
    if "canteen" in value or "mess" in value or "food" in value:
        return "canteen"
    if "library" in value:
        return "library"
    if "reading" in value:
        return "reading_room"
    if "lab" in value:
        return "lab"
    if "class" in value or "lecture" in value or "room" in value:
        return "classroom"
    if any(word in value for word in ("sport", "ground", "court", "gym")):
        return "sports"
    return "default"


def synthetic_occupancy(capacity, observed_at, pattern, randomizer):
    hour = observed_at.hour + observed_at.minute / 60
    peak_load = sum(
        math.exp(-((hour - peak) ** 2) / (2 * pattern.peak_width ** 2))
        for peak in pattern.peak_hours
    )
    weekday_multiplier = 1.0 if observed_at.weekday() < 5 else pattern.weekend_rate
    rate = pattern.base_rate + min(0.82, peak_load * 0.24) * weekday_multiplier
    rate += randomizer.gauss(0, pattern.noise)
    return max(0, min(capacity, round(capacity * rate)))


class DemoOccupancySource(OccupancySource):
    name = "DEMO_SYNTHETIC"

    def __init__(self, seed=None):
        self.randomizer = random.Random(seed)

    def observe(
        self,
        campus_id,
        location_id,
        capacity,
        occupied=None,
        facility_category_name="default",
        **kwargs,
    ):
        observed_at = kwargs.get("observed_at")
        timestamp = (
            datetime.now().replace(second=0, microsecond=0)
            if not observed_at
            else datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        )
        if timestamp.tzinfo:
            timestamp = timestamp.astimezone().replace(tzinfo=None)
        if occupied is None:
            pattern = FACILITY_PATTERNS.get(
                facility_category_name, FACILITY_PATTERNS["default"]
            )
            occupied = synthetic_occupancy(
                int(capacity), timestamp, pattern, self.randomizer
            )
        return build_observation(
            campus_id,
            location_id,
            capacity,
            occupied,
            self.name,
            confidence=None,
            observed_at=timestamp.isoformat(),
        )

    def generate(
        self,
        campus_id,
        facilities,
        start_at,
        end_at,
        interval_minutes=60,
    ):
        """Yield synthetic observations without writing to the database."""
        if interval_minutes <= 0:
            raise ValueError("interval_minutes must be greater than zero")
        if end_at <= start_at:
            raise ValueError("end_at must be after start_at")
        current = start_at
        while current <= end_at:
            for facility in facilities:
                yield self.observe(
                    campus_id,
                    facility["id"],
                    facility["capacity"],
                    facility_category_name=facility["category"],
                    observed_at=current.isoformat(),
                )
            current += timedelta(minutes=interval_minutes)
