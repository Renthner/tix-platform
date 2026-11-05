ALTER TABLE "seats" ADD COLUMN "companion_of_seat_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "companion_requires_wheelchair" boolean;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_companion_not_self" CHECK ("seats"."companion_of_seat_id" IS DISTINCT FROM "seats"."id");