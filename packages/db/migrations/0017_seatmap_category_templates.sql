CREATE TABLE "seat_map_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seat_map_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_map_categories_name_uq" UNIQUE("seat_map_id","name"),
	CONSTRAINT "seat_map_categories_color_format" CHECK ("seat_map_categories"."color" ~ '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$')
);
--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD COLUMN "template_category_id" uuid;--> statement-breakpoint
ALTER TABLE "seats" ADD COLUMN "template_category_id" uuid;--> statement-breakpoint
ALTER TABLE "seat_map_categories" ADD CONSTRAINT "seat_map_categories_seat_map_id_seat_maps_id_fk" FOREIGN KEY ("seat_map_id") REFERENCES "public"."seat_maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seat_map_categories_map_idx" ON "seat_map_categories" USING btree ("seat_map_id","sort_order");--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD CONSTRAINT "seat_map_sections_template_category_id_seat_map_categories_id_fk" FOREIGN KEY ("template_category_id") REFERENCES "public"."seat_map_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_template_category_id_seat_map_categories_id_fk" FOREIGN KEY ("template_category_id") REFERENCES "public"."seat_map_categories"("id") ON DELETE set null ON UPDATE no action;