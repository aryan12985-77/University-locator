"""Optional route-cost layer; existing navigation does not depend on it."""

from dataclasses import dataclass


@dataclass(frozen=True)
class RouteCost:
    distance_m: float
    congestion_penalty: float = 0.0
    accessibility_penalty: float = 0.0
    blocked_path_penalty: float = 0.0

    @property
    def total(self):
        return (
            self.distance_m
            + self.congestion_penalty
            + self.accessibility_penalty
            + self.blocked_path_penalty
        )


def route_cost(
    distance_m,
    congestion_penalty=0.0,
    accessibility_penalty=0.0,
    blocked_path_penalty=0.0,
):
    values = (
        distance_m,
        congestion_penalty,
        accessibility_penalty,
        blocked_path_penalty,
    )
    if any(float(value) < 0 for value in values):
        raise ValueError("route costs cannot be negative")
    return RouteCost(*[float(value) for value in values])
