# Context

Domain glossary for open-data-sync.

**Layer**
One ArcGIS map layer (a `/MapServer/N` or `/FeatureServer/N` URL) published by a municipality. Stored as a row in `open_data_sync.arcgis_raw_layers`. Each layer belongs to exactly one town and one data group.

**Feature**
One record inside a Layer: a set of attributes plus an optional geometry. Stored as a row in `open_data_sync.arcgis_raw_features`, identified within its layer by `source_feature_id` (the ArcGIS OBJECTID or GlobalID).

**Data group**
A category that cuts across towns, such as `ward_boundaries`, `road_segments` or `intersections`. Lets consumers query "all road segments" without caring which town published them. Copied onto each Feature (denormalized) so it can be indexed.

**Sync**
The weekly run that fetches every enabled Layer's Features from ArcGIS and upserts them into Postgres, then records `last_synced_at` on the Layer. A Sync never deletes Layers; deleting a Layer cascades to its Features.

**Raw**
Data stored as published, with no cleaning or modelling. Downstream tables and views build on the raw tables.

**Curated**
Cleaned tables and views built from Raw data by SQL in `open_data_sync`: `wards`, `road_segments`, `intersections`, with the same columns for every town. Rebuilt after a Sync that downloaded something.

**Incident location**
One row per HRPS incident in `incident_locations`, holding its town, ward and nearest intersection (within 30 m).
