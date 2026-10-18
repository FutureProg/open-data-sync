--> statement-breakpoint
CREATE TABLE "open_data_sync"."arcgis_raw_features" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"layer_id" bigint NOT NULL,
	"data_group" text NOT NULL,
	"source_feature_id" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"geometry" geometry(Geometry,4326),
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "arcgis_raw_features_layer_source_uq" UNIQUE("layer_id","source_feature_id")
);
--> statement-breakpoint
CREATE TABLE "open_data_sync"."arcgis_raw_layers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"town" text NOT NULL,
	"data_group" text NOT NULL,
	"name" text,
	"service_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arcgis_raw_layers_service_url_unique" UNIQUE("service_url")
);
--> statement-breakpoint
ALTER TABLE "open_data_sync"."arcgis_raw_features" ADD CONSTRAINT "arcgis_raw_features_layer_id_arcgis_raw_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "open_data_sync"."arcgis_raw_layers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arcgis_raw_features_data_group_idx" ON "open_data_sync"."arcgis_raw_features" USING btree ("data_group");--> statement-breakpoint
CREATE INDEX "arcgis_raw_features_layer_id_idx" ON "open_data_sync"."arcgis_raw_features" USING btree ("layer_id");--> statement-breakpoint
CREATE INDEX "arcgis_raw_features_geometry_gist" ON "open_data_sync"."arcgis_raw_features" USING gist ("geometry");