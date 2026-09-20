"""Metrics implemented without requiring scikit-learn."""

import math


def regression_metrics(actual, predicted):
    actual, predicted = list(actual), list(predicted)
    if len(actual) != len(predicted) or not actual:
        raise ValueError("actual and predicted must be non-empty and equal length")
    errors = [float(p) - float(a) for a, p in zip(actual, predicted)]
    mae = sum(abs(error) for error in errors) / len(errors)
    rmse = math.sqrt(sum(error * error for error in errors) / len(errors))
    mean = sum(float(value) for value in actual) / len(actual)
    total = sum((float(value) - mean) ** 2 for value in actual)
    r2 = 0.0 if total == 0 else 1 - sum(error * error for error in errors) / total
    non_zero = [(abs(float(a)), abs(error)) for a, error in zip(actual, errors) if float(a) != 0]
    mape = None if not non_zero else 100 * sum(error / value for value, error in non_zero) / len(non_zero)
    return {"mae": mae, "rmse": rmse, "r2": r2, "mape": mape}
