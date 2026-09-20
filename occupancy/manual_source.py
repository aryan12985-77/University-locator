"""Manual occupancy observations submitted by an operator or trusted API client."""

from .base import OccupancySource, build_observation


class ManualOccupancySource(OccupancySource):
    name = "REAL_MANUAL"

    def observe(self, campus_id, location_id, capacity, occupied, **kwargs):
        return build_observation(
            campus_id,
            location_id,
            capacity,
            occupied,
            self.name,
            confidence=kwargs.get("confidence"),
            observed_at=kwargs.get("observed_at"),
        )
