-- Intersections also form where a street ends on the side of another with no segment break (a T-junction).
-- Controlled-access highways and ramps are left out (Highway 5 and 25 are arterials, so they stay in), so an
-- overpass is not an intersection. road_segments gains controlled_access, so it is rebuilt along with intersections
-- and integration_qa, which read it.
DROP VIEW "incidents"."integration_qa";--> statement-breakpoint
DROP MATERIALIZED VIEW "geo"."intersections";--> statement-breakpoint
DROP MATERIALIZED VIEW "geo"."road_segments";--> statement-breakpoint

-- The name test, for towns whose layer has no highway attribute (Halton Hills) and as a backstop elsewhere.
CREATE FUNCTION "geo"."is_highway_name"(street_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
	SELECT street_key ~* '(^|\s)(qew|q\.e\.w|40[137]|ramp)(\s|$)'
$$;--> statement-breakpoint

CREATE MATERIALIZED VIEW "geo"."road_segments" AS
WITH src AS (
	SELECT
		l.town,
		f.source_feature_id,
		geo.normalize_street_name(f.attributes ->> m.street_name_field) AS street_name,
		NULLIF(btrim(f.attributes ->> m.road_class_field), '') AS road_class,
		f.attributes AS attrs,
		ST_Transform(f.geometry, 2958) AS geom_m
	FROM "open_data_sync"."arcgis_raw_features" f
	JOIN "open_data_sync"."arcgis_raw_layers" l ON l.id = f.layer_id AND l.enabled
	JOIN "geo"."layer_field_map" m ON m.town = l.town AND m.data_group = 'road_segments'
	WHERE f.data_group = 'road_segments' AND f.geometry IS NOT NULL
)
SELECT
	s.town || ':' || s.source_feature_id || '/' || coalesce(d.path[1], 1) AS segment_id,
	s.town,
	s.street_name,
	-- The name without a trailing direction, so "Main Street South" meeting "Main Street" is one street.
	regexp_replace(s.street_name, ' (North|South|East|West)$', '') AS street_key,
	s.road_class,
	-- Lower is more major. Only numeric classes (Milton, Oakville) rank; the rest sort last.
	CASE WHEN s.road_class ~ '^[1-9]$' THEN s.road_class::smallint ELSE 99::smallint END AS class_rank,
	-- Controlled-access highways and their ramps: they pass over or beside the streets they meet, not through.
	-- Each town marks them differently; Halton Hills has no such attribute, so only the name decides there.
	-- Burlington: STREET_CLASS F (freeway) or R (ramp). Milton: CATEGORY. Oakville: PLAN_CLASS H.
	-- coalesce: a missing attribute is NULL, and NULL must read as "not controlled access".
	coalesce(
		geo.is_highway_name(regexp_replace(s.street_name, ' (North|South|East|West)$', ''))
		OR (s.town = 'Burlington' AND s.attrs ->> 'STREET_CLASS' IN ('F', 'R'))
		OR (s.town = 'Milton' AND s.attrs ->> 'CATEGORY' IN ('HIGHWAY', 'HIGHWAY RAMP'))
		OR (s.town = 'Oakville' AND s.attrs ->> 'PLAN_CLASS' = 'H'),
		false
	) AS controlled_access,
	d.geom::geometry(LineString, 2958) AS geom_m
FROM src s
CROSS JOIN LATERAL ST_Dump(s.geom_m) d
WHERE ST_GeometryType(d.geom) = 'ST_LineString' AND NOT ST_IsEmpty(d.geom);--> statement-breakpoint
CREATE UNIQUE INDEX "road_segments_segment_id_uq" ON "geo"."road_segments" ("segment_id");--> statement-breakpoint
CREATE INDEX "road_segments_geom_m_gist" ON "geo"."road_segments" USING gist ("geom_m");--> statement-breakpoint

CREATE MATERIALIZED VIEW "geo"."intersections" AS
WITH RECURSIVE segment_ends AS (
	SELECT s.town, s.street_key, s.class_rank, s.controlled_access, e.pt
	FROM "geo"."road_segments" s
	CROSS JOIN LATERAL (VALUES (ST_StartPoint(s.geom_m)), (ST_EndPoint(s.geom_m))) e(pt)
	WHERE s.street_key IS NOT NULL
), ends AS (
	SELECT town, street_key, class_rank, pt FROM segment_ends
	UNION ALL
	-- A street that ends on the side of another (a T-junction) has no segment break there, so the through
	-- street gets a point at the same spot. Controlled-access roads are skipped: they pass over or beside, not through.
	SELECT t.town, t.street_key, t.class_rank, e.pt
	FROM segment_ends e
	JOIN "geo"."road_segments" t
		ON t.street_key IS NOT NULL AND t.street_key <> e.street_key AND ST_DWithin(t.geom_m, e.pt, 3)
	WHERE NOT ST_DWithin(ST_StartPoint(t.geom_m), e.pt, 3)
		AND NOT ST_DWithin(ST_EndPoint(t.geom_m), e.pt, 3)
		AND NOT e.controlled_access
		AND NOT t.controlled_access
), clustered AS (
	SELECT *, ST_ClusterDBSCAN(pt, 3, 1) OVER () AS cid FROM ends
), nodes AS (
	SELECT cid AS node_id, ST_Centroid(ST_Collect(pt)) AS pt
	FROM clustered
	GROUP BY cid
	HAVING count(DISTINCT street_key) >= 2
), node_streets AS (
	SELECT c.cid AS node_id, c.street_key, c.town, min(c.class_rank) AS class_rank,
		ST_Centroid(ST_Collect(c.pt)) AS pt
	FROM clustered c
	JOIN nodes n ON n.node_id = c.cid
	GROUP BY c.cid, c.street_key, c.town
), links AS (
	-- Per street, nodes within 20 m of each other share a link.
	SELECT node_id, street_key,
		ST_ClusterDBSCAN(pt, 20, 1) OVER (PARTITION BY street_key) AS link_id
	FROM (
		SELECT node_id, street_key, ST_Centroid(ST_Collect(pt)) AS pt
		FROM node_streets
		GROUP BY node_id, street_key
	) per_street
), edges AS (
	SELECT a.node_id AS a, b.node_id AS b
	FROM links a
	JOIN links b ON a.street_key = b.street_key AND a.link_id = b.link_id AND a.node_id <> b.node_id
), reach(node_id, label) AS (
	SELECT node_id, node_id FROM nodes
	UNION
	SELECT e.b, r.label FROM reach r JOIN edges e ON e.a = r.node_id
), comp AS (
	SELECT node_id, min(label) AS comp_id FROM reach GROUP BY node_id
), merged_points AS (
	SELECT c.comp_id, ST_Centroid(ST_Collect(n.pt)) AS geom_m
	FROM comp c JOIN nodes n ON n.node_id = c.node_id
	GROUP BY c.comp_id
), comp_towns AS (
	SELECT comp_id, (array_agg(town ORDER BY cnt DESC, town))[1] AS town
	FROM (
		SELECT c.comp_id, ns.town, count(*) AS cnt
		FROM comp c JOIN node_streets ns ON ns.node_id = c.node_id
		GROUP BY c.comp_id, ns.town
	) t
	GROUP BY comp_id
), comp_streets AS (
	SELECT comp_id,
		array_agg(street_key ORDER BY class_rank, street_key) AS street_names
	FROM (
		SELECT c.comp_id, ns.street_key, min(ns.class_rank) AS class_rank
		FROM comp c JOIN node_streets ns ON ns.node_id = c.node_id
		GROUP BY c.comp_id, ns.street_key
	) s
	GROUP BY comp_id
), final AS (
	SELECT
		-- Precision 10 is a cell of about 1.2 m by 0.6 m; intersections are at least 3 m apart.
		ST_GeoHash(ST_Transform(p.geom_m, 4326), 10) AS base_id,
		t.town,
		s.street_names,
		array_to_string(s.street_names, ' & ') AS label,
		p.geom_m
	FROM merged_points p
	JOIN comp_towns t USING (comp_id)
	JOIN comp_streets s USING (comp_id)
)
SELECT
	-- Two intersections in the same geohash cell would share an id. The first keeps the plain geohash; any others
	-- get -2, -3 ... in label order, so every row has a unique id and none is dropped.
	base_id || CASE WHEN row_number() OVER w > 1 THEN '-' || row_number() OVER w ELSE '' END AS intersection_id,
	town,
	street_names,
	label,
	ST_Transform(geom_m, 4326)::geometry(Point, 4326) AS geom,
	geom_m::geometry(Point, 2958) AS geom_m
FROM final
WINDOW w AS (PARTITION BY base_id ORDER BY label, ST_X(geom_m), ST_Y(geom_m));--> statement-breakpoint
CREATE UNIQUE INDEX "intersections_intersection_id_uq" ON "geo"."intersections" ("intersection_id");--> statement-breakpoint
CREATE INDEX "intersections_geom_m_gist" ON "geo"."intersections" USING gist ("geom_m");--> statement-breakpoint
CREATE INDEX "intersections_geom_gist" ON "geo"."intersections" USING gist ("geom");--> statement-breakpoint

-- One row of counts the cron logs after every refresh.
CREATE VIEW "incidents"."integration_qa" AS
SELECT
	(SELECT count(*) FROM safe_streets_halton.hrps_data) AS incidents_total,
	(SELECT count(*) FROM safe_streets_halton.hrps_data h
		WHERE NOT EXISTS (SELECT 1 FROM incidents.incident_locations il WHERE il.global_id = h."globalId")) AS incidents_unlocated,
	(SELECT count(*) FROM incidents.incident_locations WHERE ward_id IS NULL) AS incidents_without_ward,
	(SELECT count(*) FROM incidents.incident_locations
		WHERE ward_town IS NOT NULL AND town IS DISTINCT FROM ward_town) AS ward_town_mismatches,
	(SELECT round(avg((intersection_id IS NOT NULL)::int)::numeric, 4) FROM incidents.incident_locations) AS share_near_intersection,
	(SELECT coalesce(jsonb_object_agg(town, n), '{}'::jsonb)
		FROM (SELECT town, count(*) AS n FROM geo.intersections GROUP BY town) t) AS intersections_per_town,
	(SELECT count(*) FROM safe_streets_halton.hrps_data h
		WHERE NOT EXISTS (SELECT 1 FROM incidents.incident_type_groups g WHERE g.description = upper(btrim(h.description)))) AS unknown_description_incidents,
	(SELECT coalesce(array_agg(DISTINCT upper(btrim(h.description)) ORDER BY upper(btrim(h.description))), ARRAY[]::text[])
		FROM safe_streets_halton.hrps_data h
		WHERE NOT EXISTS (SELECT 1 FROM incidents.incident_type_groups g WHERE g.description = upper(btrim(h.description)))) AS unknown_descriptions;
