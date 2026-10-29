-- Intersections also form where a street ends on the side of another with no segment break (a T-junction).
-- Highway and ramp names are left out (Highway 5 and 25 are arterials, so they stay in), so an overpass is not an intersection. Rebuilds the view; integration_qa
-- reads it, so it is dropped and recreated too.
DROP VIEW "incidents"."integration_qa";--> statement-breakpoint
DROP MATERIALIZED VIEW "geo"."intersections";--> statement-breakpoint

CREATE FUNCTION "geo"."is_highway_name"(street_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
	SELECT street_key ~* '(^|\s)(wb|eb|qew|q\.e\.w|40[137])(\s|$)' OR street_key ~* '\sto\s'
$$;--> statement-breakpoint

CREATE MATERIALIZED VIEW "geo"."intersections" AS
WITH RECURSIVE segment_ends AS (
	SELECT s.town, s.street_key, s.class_rank, e.pt
	FROM "geo"."road_segments" s
	CROSS JOIN LATERAL (VALUES (ST_StartPoint(s.geom_m)), (ST_EndPoint(s.geom_m))) e(pt)
	WHERE s.street_key IS NOT NULL
), ends AS (
	SELECT * FROM segment_ends
	UNION ALL
	-- A street that ends on the side of another (a T-junction) has no segment break there, so the through
	-- street gets a point at the same spot. Highways and ramps are skipped: they pass over or beside, not through.
	SELECT t.town, t.street_key, t.class_rank, e.pt
	FROM segment_ends e
	JOIN "geo"."road_segments" t
		ON t.street_key IS NOT NULL AND t.street_key <> e.street_key AND ST_DWithin(t.geom_m, e.pt, 3)
	WHERE NOT ST_DWithin(ST_StartPoint(t.geom_m), e.pt, 3)
		AND NOT ST_DWithin(ST_EndPoint(t.geom_m), e.pt, 3)
		AND NOT "geo"."is_highway_name"(e.street_key)
		AND NOT "geo"."is_highway_name"(t.street_key)
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
