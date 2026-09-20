"""Optional actual-vs-predicted persistence for later evaluation."""

import sqlite3


def ensure_prediction_table(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS occupancy_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model_name TEXT NOT NULL,
            campus_id INTEGER NOT NULL,
            location_id INTEGER NOT NULL,
            observed_at TEXT NOT NULL,
            predicted_percentage REAL NOT NULL,
            actual_percentage REAL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)
    connection.commit()


def store_prediction(connection, model_name, prediction):
    ensure_prediction_table(connection)
    connection.execute("""
        INSERT INTO occupancy_predictions
        (model_name, campus_id, location_id, observed_at,
         predicted_percentage, actual_percentage)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (model_name, prediction["campus_id"], prediction["location_id"],
          prediction["observed_at"], prediction["predicted_percentage"],
          prediction.get("actual_percentage")))
    connection.commit()
