CREATE TABLE "open_data_sync"."incident_locations" (
	"global_id" varchar(255) PRIMARY KEY NOT NULL,
	"town" text,
	"ward_id" text,
	"ward_town" text,
	"intersection_id" text,
	"distance_to_intersection_m" real,
	"geom" geometry(Point,4326) NOT NULL,
	"source_updated_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_data_sync"."incident_type_groups" (
	"description" text PRIMARY KEY NOT NULL,
	"is_collision" boolean NOT NULL,
	"is_injury_or_fatal" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_data_sync"."layer_field_map" (
	"town" text NOT NULL,
	"data_group" text NOT NULL,
	"ward_number_field" text,
	"ward_name_field" text,
	"street_name_field" text,
	"road_class_field" text,
	CONSTRAINT "layer_field_map_town_data_group_pk" PRIMARY KEY("town","data_group")
);
--> statement-breakpoint
CREATE INDEX "incident_locations_geom_gist" ON "open_data_sync"."incident_locations" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "incident_locations_ward_id_idx" ON "open_data_sync"."incident_locations" USING btree ("ward_id");--> statement-breakpoint
CREATE INDEX "incident_locations_intersection_id_idx" ON "open_data_sync"."incident_locations" USING btree ("intersection_id");