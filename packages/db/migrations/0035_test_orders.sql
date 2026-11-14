ALTER TABLE "events" ADD COLUMN "had_test_orders" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "test_hidden_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_test_idx" ON "orders" USING btree ("created_at") WHERE "orders"."is_test";