ALTER TABLE "waitlist_entries" DROP CONSTRAINT "waitlist_entries_category_id_price_categories_id_fk";
--> statement-breakpoint
DROP INDEX "waitlist_entries_event_email_uq";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "waitlist_trigger" text;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_category_id_price_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_event_email_category_uq" ON "waitlist_entries" USING btree ("event_id",lower("email"),coalesce("category_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_waitlist_trigger_valid" CHECK ("events"."waitlist_trigger" IS NULL OR "events"."waitlist_trigger" IN ('WHEN_SOLD_OUT', 'WHEN_UNAVAILABLE'));