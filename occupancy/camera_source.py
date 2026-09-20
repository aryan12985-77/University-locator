"""Privacy-safe camera occupancy adapter.

This module accepts an aggregate people count from a future detector. It does
not process faces, retain frames, or claim that campus CCTV is connected.
"""

from .base import OccupancySource, build_observation


class CameraOccupancySource(OccupancySource):
    name = "CAMERA_AGGREGATE"

    def observe_count(
        self,
        campus_id,
        location_id,
        capacity,
        people_count,
        confidence=None,
        observed_at=None,
    ):
        return build_observation(
            campus_id,
            location_id,
            capacity,
            people_count,
            self.name,
            confidence=confidence,
            observed_at=observed_at,
        )

    def detect_people(self, frame):
        """Placeholder for a detector integration; no frame is persisted."""
        raise NotImplementedError(
            "No camera detector is connected; provide an aggregate count "
            "from a privacy-reviewed detector."
        )
