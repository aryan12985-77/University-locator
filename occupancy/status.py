"""Shared occupancy status thresholds."""

THRESHOLDS = {
    "low": 0.40,
    "moderate": 0.70,
    "high": 0.90,
}


def occupancy_status(percentage):
    """Return a stable label for a 0-100 occupancy percentage."""
    percentage = float(percentage)
    ratio = percentage / 100
    if ratio < THRESHOLDS["low"]:
        return "LOW"
    if ratio < THRESHOLDS["moderate"]:
        return "MODERATE"
    if ratio < THRESHOLDS["high"]:
        return "HIGH"
    return "VERY HIGH"
