ALTER TYPE "public"."email_template_key" ADD VALUE 'ADDITIONAL_PAYMENT_SETTLED_BY_CREDIT' BEFORE 'TICKETS_RESENT';--> statement-breakpoint
ALTER TABLE "order_adjustments" DROP CONSTRAINT "order_adjustments_amount_positive";--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD COLUMN "credit_applied" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "batch_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
-- Refunds of one cancellation share its credit note: one batch per (order, credit note); every
-- other existing row keeps its own batch (the volatile default above).
UPDATE "refunds" r SET "batch_id" = g."batch_id" FROM (SELECT "order_id", "credit_note_id", gen_random_uuid() AS "batch_id" FROM "refunds" WHERE "credit_note_id" IS NOT NULL GROUP BY "order_id", "credit_note_id") g WHERE r."order_id" = g."order_id" AND r."credit_note_id" = g."credit_note_id";--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "overpayment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "refunds_batch_idx" ON "refunds" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_amount_nonneg" CHECK ("order_adjustments"."amount" >= 0);--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_credit_nonneg" CHECK ("order_adjustments"."credit_applied" >= 0);