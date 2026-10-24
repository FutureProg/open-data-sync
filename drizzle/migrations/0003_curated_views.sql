-- Curated data built from the raw open data and the HRPS incidents, split by domain:
--   geo        Halton reference geography: wards, road segments, intersections.
--   incidents  Police incident enrichment: each incident's town, ward and intersection.
-- Dependencies run one way: incidents reads geo, geo never reads incidents.
-- safe_streets_halton.hrps_data is only ever read. Distances use EPSG:2958
-- (NAD83(CSRS) / UTM zone 17N), which covers all of Halton, so they are in metres.
INSERT INTO "geo"."layer_field_map" ("town", "data_group", "ward_number_field", "ward_name_field", "street_name_field", "road_class_field") VALUES
	('Burlington', 'ward_boundaries', 'WARD_NO_INTEGER', NULL, NULL, NULL),
	('Oakville', 'ward_boundaries', 'Ward', 'FULL_NAME', NULL, NULL),
	('Milton', 'ward_boundaries', 'WARD_NUM', 'Name', NULL, NULL),
	('Halton Hills', 'ward_boundaries', 'WARD', NULL, NULL, NULL),
	('Burlington', 'road_segments', NULL, NULL, 'MOFULLNAME', 'STREET_CLASS'),
	('Oakville', 'road_segments', NULL, NULL, 'FULL_STREET_NAME', 'STREET_CLA'),
	('Milton', 'road_segments', NULL, NULL, 'DISPLAY_NAME', 'ROADCLASS'),
	('Halton Hills', 'road_segments', NULL, NULL, 'STR_FULL', NULL);--> statement-breakpoint
INSERT INTO "incidents"."incident_type_groups" ("description", "is_collision", "is_injury_or_fatal") VALUES
	('MVC - PI', true, true),
	('MVC - FATALITY', true, true),
	('MVC - HIT & RUN', true, false),
	('DANGEROUS OPERATION - TRAFFIC', false, false),
	('ROADSIDE TEST', false, false),
	('THEFT OF BICYCLE', false, false),
	('IMPAIRED DRIVING', false, false);--> statement-breakpoint

-- "BRANT ST." and "Brant Street" must match. Suffix abbreviations expand when they are not the
-- first word; a trailing N/S/E/W becomes a full direction. "St" is Saint when it starts the name or
-- is followed by more of the name ("St Georges Rd", "Louis St Laurent Ave"), and Street when it ends
-- the name or only a direction follows ("Main St", "King St W").
CREATE FUNCTION "geo"."normalize_street_name"(raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	words text[];
	n int;
	i int;
	j int;
	w text;
BEGIN
	IF raw IS NULL THEN RETURN NULL; END IF;
	words := regexp_split_to_array(
		btrim(regexp_replace(lower(regexp_replace(raw, '\([^)]*\)', ' ', 'g')), '[\s]+', ' ', 'g')),
		' ');
	n := coalesce(array_length(words, 1), 0);
	IF n = 0 OR words[1] = '' THEN RETURN NULL; END IF;
	-- Placeholders some layers use for "no name" (e.g. Oakville's "NA") are not streets.
	IF n = 1 AND rtrim(words[1], '.') IN ('na', 'n/a', 'none', 'null', 'unknown', 'unnamed', 'tbd', '0') THEN
		RETURN NULL;
	END IF;
	FOR i IN 1..n LOOP
		w := rtrim(words[i], '.,');
		IF w = 'st' THEN
			j := n;
			IF j > i AND rtrim(words[j], '.,') IN ('n', 's', 'e', 'w', 'north', 'south', 'east', 'west') THEN
				j := j - 1;
			END IF;
			w := CASE WHEN i = 1 OR j > i THEN 'saint' ELSE 'street' END;
		ELSIF i > 1 THEN
			w := CASE w
				WHEN 'st' THEN 'street' WHEN 'str' THEN 'street' WHEN 'rd' THEN 'road'
				WHEN 'ave' THEN 'avenue' WHEN 'av' THEN 'avenue' WHEN 'dr' THEN 'drive'
				WHEN 'blvd' THEN 'boulevard' WHEN 'cres' THEN 'crescent' WHEN 'ct' THEN 'court'
				WHEN 'crt' THEN 'court' WHEN 'ln' THEN 'lane' WHEN 'cir' THEN 'circle'
				WHEN 'pkwy' THEN 'parkway' WHEN 'hwy' THEN 'highway' WHEN 'trl' THEN 'trail'
				WHEN 'terr' THEN 'terrace' WHEN 'ter' THEN 'terrace' WHEN 'pl' THEN 'place'
				WHEN 'sq' THEN 'square' WHEN 'gdns' THEN 'gardens' WHEN 'hts' THEN 'heights'
				ELSE w END;
		END IF;
		IF i = n AND n > 1 THEN
			w := CASE w
				WHEN 'n' THEN 'north' WHEN 's' THEN 'south' WHEN 'e' THEN 'east' WHEN 'w' THEN 'west'
				ELSE w END;
		END IF;
		words[i] := w;
	END LOOP;
	RETURN initcap(array_to_string(words, ' '));
END
$$;--> statement-breakpoint

-- Police city to municipality: Georgetown and Acton are Halton Hills. Unknown cities pass through.
CREATE FUNCTION "incidents"."incident_town"(city text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE upper(btrim(city))
		WHEN 'BURLINGTON' THEN 'Burlington'
		WHEN 'OAKVILLE' THEN 'Oakville'
		WHEN 'MILTON' THEN 'Milton'
		WHEN 'HALTON HILLS' THEN 'Halton Hills'
		WHEN 'GEORGETOWN' THEN 'Halton Hills'
		WHEN 'ACTON' THEN 'Halton Hills'
		ELSE NULLIF(btrim(city), '')
	END
$$;--> statement-breakpoint

CREATE MATERIALIZED VIEW "geo"."wards" AS
WITH parsed AS (
	SELECT
		l.town,
		NULLIF(substring(f.attributes ->> m.ward_number_field from '\d+'), '')::int AS ward_number,
		NULLIF(btrim(f.attributes ->> m.ward_name_field), '') AS ward_name,
		f.geometry
	FROM "open_data_sync"."arcgis_raw_features" f
	JOIN "open_data_sync"."arcgis_raw_layers" l ON l.id = f.layer_id AND l.enabled
	JOIN "geo"."layer_field_map" m ON m.town = l.town AND m.data_group = 'ward_boundaries'
	WHERE f.data_group = 'ward_boundaries' AND f.geometry IS NOT NULL
), merged AS (
	SELECT
		town,
		ward_number,
		max(ward_name) AS ward_name,
		ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(geometry)), 3)) AS geom
	FROM parsed
	WHERE ward_number IS NOT NULL
	GROUP BY town, ward_number
), projected AS (
	SELECT *, ST_Transform(geom, 2958) AS geom_m FROM merged
)
SELECT
	lower(replace(town, ' ', '-')) || '-' || ward_number AS ward_id,
	town,
	ward_number,
	coalesce(ward_name, 'Ward ' || ward_number) AS ward_name,
	geom::geometry(MultiPolygon, 4326) AS geom,
	geom_m::geometry(MultiPolygon, 2958) AS geom_m,
	ST_Transform(ST_Multi(ST_SimplifyPreserveTopology(geom_m, 5)), 4326)::geometry(MultiPolygon, 4326) AS geom_display
FROM projected;--> statement-breakpoint
CREATE UNIQUE INDEX "wards_ward_id_uq" ON "geo"."wards" ("ward_id");--> statement-breakpoint
CREATE INDEX "wards_geom_m_gist" ON "geo"."wards" USING gist ("geom_m");--> statement-breakpoint

CREATE MATERIALIZED VIEW "geo"."road_segments" AS
WITH src AS (
	SELECT
		l.town,
		f.source_feature_id,
		geo.normalize_street_name(f.attributes ->> m.street_name_field) AS street_name,
		NULLIF(btrim(f.attributes ->> m.road_class_field), '') AS road_class,
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
	d.geom::geometry(LineString, 2958) AS geom_m
FROM src s
CROSS JOIN LATERAL ST_Dump(s.geom_m) d
WHERE ST_GeometryType(d.geom) = 'ST_LineString' AND NOT ST_IsEmpty(d.geom);--> statement-breakpoint
CREATE UNIQUE INDEX "road_segments_segment_id_uq" ON "geo"."road_segments" ("segment_id");--> statement-breakpoint
CREATE INDEX "road_segments_geom_m_gist" ON "geo"."road_segments" USING gist ("geom_m");--> statement-breakpoint

-- Derived the same way for every town: segment end points within 3 m form a node; a node where two
-- or more distinct streets meet is an intersection; nodes within 20 m that share a street (a divided
-- road, a small roundabout, or the same boundary road published by two towns) merge into one.
CREATE MATERIALIZED VIEW "geo"."intersections" AS
WITH RECURSIVE ends AS (
	SELECT s.town, s.street_key, s.class_rank, e.pt
	FROM "geo"."road_segments" s
	CROSS JOIN LATERAL (VALUES (ST_StartPoint(s.geom_m)), (ST_EndPoint(s.geom_m))) e(pt)
	WHERE s.street_key IS NOT NULL
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

-- Incremental: handles incidents with no row yet, or whose updated_at is newer than the copy
-- kept in source_updated_at, and deletes rows whose incident is gone. recompute_all redoes every
-- incident (used after the curated views change). Returns the number of rows written.
CREATE FUNCTION "incidents"."refresh_incident_locations"(recompute_all boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
	written integer;
BEGIN
	DELETE FROM incidents.incident_locations il
	WHERE NOT EXISTS (
		SELECT 1 FROM safe_streets_halton.hrps_data h WHERE h."globalId" = il.global_id
	);

	INSERT INTO incidents.incident_locations AS il
		(global_id, town, ward_id, ward_town, intersection_id, distance_to_intersection_m, geom, source_updated_at, computed_at)
	SELECT
		l.global_id,
		incidents.incident_town(l.city),
		coalesce(cov.ward_id, near.ward_id),
		coalesce(cov.town, near.town),
		ix.intersection_id,
		ix.dist,
		l.geom,
		l.updated_at,
		now()
	FROM (
		SELECT
			h."globalId" AS global_id,
			h.city,
			h.updated_at,
			ST_SetSRID(ST_MakePoint(h.longitude, h.latitude), 4326) AS geom,
			ST_Transform(ST_SetSRID(ST_MakePoint(h.longitude, h.latitude), 4326), 2958) AS geom_m
		FROM safe_streets_halton.hrps_data h
		LEFT JOIN incidents.incident_locations old ON old.global_id = h."globalId"
		WHERE h.latitude BETWEEN -90 AND 90 AND h.longitude BETWEEN -180 AND 180
			AND (recompute_all OR old.global_id IS NULL OR h.updated_at > old.source_updated_at)
	) l
	LEFT JOIN LATERAL (
		-- A point on a shared boundary goes to the lower ward_id, so it is never counted twice.
		SELECT w.ward_id, w.town FROM geo.wards w
		WHERE ST_Covers(w.geom_m, l.geom_m)
		ORDER BY w.ward_id LIMIT 1
	) cov ON true
	LEFT JOIN LATERAL (
		-- Just offshore or outside a ward: the nearest ward within 50 m, otherwise none.
		SELECT w.ward_id, w.town FROM geo.wards w
		WHERE cov.ward_id IS NULL AND ST_DWithin(w.geom_m, l.geom_m, 50)
		ORDER BY ST_Distance(w.geom_m, l.geom_m), w.ward_id LIMIT 1
	) near ON true
	LEFT JOIN LATERAL (
		-- Nearest intersection within 30 m, so two intersections never share an incident.
		SELECT i.intersection_id, ST_Distance(i.geom_m, l.geom_m)::real AS dist
		FROM geo.intersections i
		WHERE ST_DWithin(i.geom_m, l.geom_m, 30)
		ORDER BY ST_Distance(i.geom_m, l.geom_m), i.intersection_id LIMIT 1
	) ix ON true
	ON CONFLICT (global_id) DO UPDATE SET
		town = EXCLUDED.town,
		ward_id = EXCLUDED.ward_id,
		ward_town = EXCLUDED.ward_town,
		intersection_id = EXCLUDED.intersection_id,
		distance_to_intersection_m = EXCLUDED.distance_to_intersection_m,
		geom = EXCLUDED.geom,
		source_updated_at = EXCLUDED.source_updated_at,
		computed_at = EXCLUDED.computed_at;
	GET DIAGNOSTICS written = ROW_COUNT;
	RETURN written;
END
$$;--> statement-breakpoint

-- Rebuilds the three geo views. Incident locations are recomputed separately, by calling
-- incidents.refresh_incident_locations(true) afterwards, so geo never depends on incidents.
CREATE FUNCTION "geo"."refresh_curated"() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	REFRESH MATERIALIZED VIEW geo.wards;
	REFRESH MATERIALIZED VIEW geo.road_segments;
	REFRESH MATERIALIZED VIEW geo.intersections;
END
$$;--> statement-breakpoint

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
