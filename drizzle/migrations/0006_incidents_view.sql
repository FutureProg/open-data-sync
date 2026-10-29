-- hrps_data holds several rows per case_no: the one-off backfill fans some cases out (5 to 14 rows) and every daily
-- load re-inserts the last week under fresh globalIds, so the upsert never matches. This view is the de-duplicated
-- list consumers should read: one row per case_no. hrps_data itself is not changed.
--
-- The kept row is the copy whose coordinates land on a real intersection, then the one from the latest load, then
-- the closest to its intersection, then the most recently updated, then the lowest global_id (so the choice is stable).
-- A case can carry several descriptions (for example MVC - FATALITY and MVC - PI): `descriptions` lists them all and
-- `description` is the most serious. `copies` is how many hrps_data rows were collapsed.
CREATE VIEW "incidents"."incidents" AS
WITH per_case AS (
	SELECT
		h.case_no,
		count(*) AS copies,
		array_agg(DISTINCT upper(btrim(h.description))) AS descriptions
	FROM safe_streets_halton.hrps_data h
	GROUP BY h.case_no
),
ranked AS (
	SELECT
		h.case_no,
		h."globalId" AS global_id,
		h.date,
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
		row_number() OVER (
			PARTITION BY h.case_no
			ORDER BY (il.intersection_id IS NOT NULL) DESC, h.inserted_at DESC,
				il.distance_to_intersection_m ASC NULLS LAST, h.updated_at DESC, h."globalId"
		) AS rn
	FROM safe_streets_halton.hrps_data h
	LEFT JOIN incidents.incident_locations il ON il.global_id = h."globalId"
)
SELECT
	r.case_no,
	r.global_id,
	r.date,
	(SELECT d FROM unnest(p.descriptions) AS d
		ORDER BY array_position(
			ARRAY['MVC - FATALITY', 'MVC - PI', 'MVC - HIT & RUN', 'DANGEROUS OPERATION - TRAFFIC',
				'IMPAIRED DRIVING', 'ROADSIDE TEST', 'THEFT OF BICYCLE'], d) NULLS LAST, d
		LIMIT 1) AS description,
	p.descriptions,
	r.location,
	r.city,
	r.latitude,
	r.longitude,
	r.town,
	r.ward_id,
	r.ward_town,
	r.intersection_id,
	r.distance_to_intersection_m,
	r.geom,
	p.copies
FROM ranked r
JOIN per_case p USING (case_no)
WHERE r.rn = 1;
