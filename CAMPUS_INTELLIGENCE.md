# Campus Intelligence

## Current implementation

The Flask application keeps campus navigation and occupancy data in SQLite.
Occupancy observations are associated with both `campus_id` and
`location_id`. Manual observations use `REAL_MANUAL`; generated development
records use `DEMO_SYNTHETIC`. Synthetic data is not real sensor or CCTV data.

The occupancy APIs support observation ingestion, historical and current
queries, date-range filtering, campus/facility summaries, and configurable
synthetic generation. Existing navigation routes remain independent of
occupancy.

## Research pipeline

The ML package trains only when sufficient historical observations exist. It
uses chronological data splits, stores model metadata, and reports evaluation
metrics rather than inventing confidence or accuracy. Generated model files
are local artifacts under `models/` and are ignored by Git.

The reusable implementation is in `ml/`: deterministic calendar/capacity
features, a chronological train/validation/test splitter, an interpretable
seasonal-mean baseline, and an optional scikit-learn histogram-gradient model
when scikit-learn is already installed. `PredictionService` loads rows from
`occupancy_observations`, refuses undersized datasets, and reports MAE, RMSE,
R2, and MAPE. `ml.storage` provides opt-in SQLite storage for actual-versus-
predicted values; no prediction is written unless a caller explicitly stores
it.

## Privacy and future sources

The camera source accepts an aggregate people count from a future,
privacy-reviewed detector. It does not perform face recognition or store
frames. Sensor, Wi-Fi, app-signal, and real camera integrations are not
connected by default.

## Limitations

Synthetic records are useful for pipeline development but do not establish
real-world occupancy accuracy. Model quality must be evaluated again after
validated observations from real sources are collected.
