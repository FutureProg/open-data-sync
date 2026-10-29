-- refresh_incident_locations calls PostGIS functions (ST_MakePoint, ...) unqualified, so it only worked from a
-- session whose search_path includes the schema PostGIS lives in (public). A SQL client with its own default
-- schema failed with "function st_makepoint(...) does not exist". Pin the path on the function itself.
ALTER FUNCTION "incidents"."refresh_incident_locations"(boolean) SET search_path = public;
