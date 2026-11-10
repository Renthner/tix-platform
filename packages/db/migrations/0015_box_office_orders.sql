ALTER TABLE "orders" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_online_has_buyer" CHECK ("orders"."channel" <> 'ONLINE' OR ("orders"."customer_id" IS NOT NULL AND "orders"."email" IS NOT NULL));
--> statement-breakpoint
-- Fees without a channel restriction were charged online only so far: make that explicit.
UPDATE "fees" SET "channels" = ARRAY['ONLINE']::sales_channel[] WHERE "channels" IS NULL OR cardinality("channels") = 0;
