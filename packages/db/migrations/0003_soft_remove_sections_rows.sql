ALTER TABLE "seat_map_rows" DROP CONSTRAINT "seat_map_rows_label_uq";--> statement-breakpoint
ALTER TABLE "seat_map_sections" DROP CONSTRAINT "seat_map_sections_name_uq";--> statement-breakpoint
ALTER TABLE "seat_map_rows" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "seat_map_rows_label_uq" ON "seat_map_rows" USING btree ("section_id","label") WHERE "seat_map_rows"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seat_map_sections_name_uq" ON "seat_map_sections" USING btree ("seat_map_id","name") WHERE "seat_map_sections"."removed_at" IS NULL;