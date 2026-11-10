ALTER TABLE "admin_users" ADD COLUMN "dashboard_preferences" jsonb;--> statement-breakpoint
CREATE INDEX "orders_paid_at_idx" ON "orders" USING btree ("paid_at") WHERE "orders"."paid_at" IS NOT NULL;