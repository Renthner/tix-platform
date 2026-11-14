CREATE TABLE "media_asset_variants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"asset_id" uuid NOT NULL,
	"format" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_asset_variants_uq" UNIQUE("asset_id","format","width"),
	CONSTRAINT "media_asset_variants_key_uq" UNIQUE("storage_key"),
	CONSTRAINT "media_asset_variants_format" CHECK ("media_asset_variants"."format" IN ('avif', 'webp')),
	CONSTRAINT "media_asset_variants_size" CHECK ("media_asset_variants"."width" > 0 AND "media_asset_variants"."height" > 0 AND "media_asset_variants"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "master_sha256" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "variants_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "variants_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "master_normalised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_asset_variants" ADD CONSTRAINT "media_asset_variants_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_master_sha256_idx" ON "media_assets" USING btree ("master_sha256");