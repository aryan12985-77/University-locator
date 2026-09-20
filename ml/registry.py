"""Filesystem model registry; artifacts are local and explicit."""

import json
import pickle
from datetime import datetime, timezone
from pathlib import Path


class ModelRegistry:
    def __init__(self, directory="models"):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def save(self, model, metadata, name="occupancy"):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        artifact = self.directory / f"{name}-{stamp}.pkl"
        with artifact.open("wb") as stream:
            pickle.dump(model, stream)
        payload = dict(metadata, artifact=str(artifact), model_name=name, created_at=stamp)
        with artifact.with_suffix(".json").open("w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
        return payload

    def load(self, metadata_path):
        metadata_path = Path(metadata_path)
        with metadata_path.open(encoding="utf-8") as stream:
            metadata = json.load(stream)
        with Path(metadata["artifact"]).open("rb") as stream:
            return pickle.load(stream), metadata
