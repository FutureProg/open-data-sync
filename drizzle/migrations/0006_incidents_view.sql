-- hrps_data holds several rows per case_no: the one-off backfill fans some cases out (5 to 14 rows) and every daily
-- load re-inserts the last week under fresh globalIds, so the upsert never matches. This materialized view is the
-- de-duplicated list consumers should read: one row per case_no. hrps_data itself is not changed.
--
-- The kept row is the copy whose coordinates land on a real intersection, then the one from the latest load, then
-- the closest to its intersection, then the most recently updated, then the lowest global_id (so the choice is stable).
-- A case can carry several descriptions (for example MVC - FATALITY and MVC - PI): `descriptions` lists them all and
-- `description` is the most serious (an unknown one ranks last). `copies` is how many hrps_data rows were collapsed.
--
-- De-duplicating reads every hrps_data row, a few seconds that grow with the table, so it is materialized and
-- refreshed by refresh_incident_locations() instead of being computed on every dashboard read. One sorted pass
-- does the grouping and the choice of row.
CREATE MATERIALIZED VIEW "incidents"."incidents" AS
WITH per_case AS (
	SELECT
		h.case_no,
		count(*) AS copies,
		array_agg(DISTINCT upper(btrim(h.description))) AS descriptions,
		coalesce(
			(ARRAY['MVC - FATALITY', 'MVC - PI', 'MVC - HIT & RUN', 'DANGEROUS OPERATION - TRAFFIC',
				'IMPAIRED DRIVING', 'ROADSIDE TEST', 'THEFT OF BICYCLE'])[min(array_position(
			ARRAY['MVC - FATALITY', 'MVC - PI', 'MVC - HIT & RUN', 'DANGEROUS OPERATION - TRAFFIC',
				'IMPAIRED DRIVING', 'ROADSIDE TEST', 'THEFT OF BICYCLE'], upper(btrim(h.description))))],
			min(upper(btrim(h.description)))) AS description,
		(array_agg(h."globalId" ORDER BY (il.intersection_id IS NOT NULL) DESC, h.inserted_at DESC,
			il.distance_to_intersection_m ASC NULLS LAST, h.updated_at DESC, h."globalId"))[1] AS global_id
	FROM safe_streets_halton.hrps_data h
	LEFT JOIN incidents.incident_locations il ON il.global_id = h."globalId"
	GROUP BY h.case_no
)
SELECT
	p.case_no,
	p.global_id,
	h.date,
	p.description,
	p.descriptions,
	h.location,
	h.city,
	h.latitude,
	h.longitude,
	il.town,
	il.ward_id,
	il.ward_town,
	il.intersection_id,
	il.distance_to_intersection_m,
	il.geom,
	p.copies
FROM per_case p
JOIN safe_streets_halton.hrps_data h ON h."globalId" = p.global_id
LEFT JOIN incidents.incident_locations il ON il.global_id = p.global_id;--> statement-breakpoint
-- The unique index lets the refresh run CONCURRENTLY, so dashboard reads never wait on it.
CREATE UNIQUE INDEX "incidents_case_no_uq" ON "incidents"."incidents" ("case_no");--> statement-breakpoint
CREATE INDEX "incidents_date_idx" ON "incidents"."incidents" ("date");--> statement-breakpoint

-- Same as before (0003, with 0005's search_path), plus refreshing incidents.incidents at the end.
CREATE OR REPLACE FUNCTION "incidents"."refresh_incident_locations"(recompute_all boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
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
	REFRESH MATERIALIZED VIEW CONCURRENTLY incidents.incidents;
	RETURN written;
END
$$;
