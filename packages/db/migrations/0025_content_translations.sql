ALTER TABLE "seat_map_elements" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "seat_map_entrances" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fees" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "price_categories" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_announcements" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_configs" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;