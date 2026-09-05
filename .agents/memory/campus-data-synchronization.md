---
name: Campus data synchronization
description: The relationship between the editable campus location source and the active SQLite dataset.
---

The active SQLite dataset can contain a location that is not present in the editable source if older setup work inserted it directly. Restoring or syncing from the source replaces the active dataset, so the source must be reconciled first.

**Why:** A restore exposed that the VGU database had a Mess record that was missing from the JSON source; syncing without reconciling would silently remove a location.

**How to apply:** Before changing reset/sync behavior, compare source and database records and make the source complete. Treat the source as authoritative only after that reconciliation.