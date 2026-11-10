ALTER TABLE "orders" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "personal_data_retained_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_retention_idx" ON "orders" USING btree ("personal_data_retained_until") WHERE "orders"."personal_data_retained_until" IS NOT NULL;