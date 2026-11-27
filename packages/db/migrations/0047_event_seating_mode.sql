CREATE TYPE "public"."event_seating_mode" AS ENUM('SEATED', 'ADMISSION');--> statement-breakpoint
ALTER TABLE "seat_maps" ALTER COLUMN "venue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "venue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "seating_mode" "event_seating_mode" DEFAULT 'SEATED' NOT NULL;--> statement-breakpoint
ALTER TABLE "seat_maps" ADD CONSTRAINT "seat_maps_template_has_venue" CHECK ("seat_maps"."kind" = 'EVENT' OR "seat_maps"."venue_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_seated_has_venue" CHECK ("events"."seating_mode" = 'ADMISSION' OR "events"."venue_id" IS NOT NULL);