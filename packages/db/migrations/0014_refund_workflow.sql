CREATE TYPE "public"."refund_kind" AS ENUM('AUTOMATIC', 'MANUAL');--> statement-breakpoint
CREATE TABLE "invoice_supersessions" (
	"invoice_id" uuid PRIMARY KEY NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refund_items" DROP CONSTRAINT "refund_items_pk";--> statement-breakpoint
ALTER TABLE "refund_items" ALTER COLUMN "order_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_items" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_items" ADD COLUMN "order_fee_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "kind" "refund_kind" DEFAULT 'AUTOMATIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "refund_fees" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "payer_iban" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "payer_name" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "completed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "bank_transaction_allocations" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "paid_cycle" integer;--> statement-breakpoint
ALTER TABLE "invoice_supersessions" ADD CONSTRAINT "invoice_supersessions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_supersessions" ADD CONSTRAINT "invoice_supersessions_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_fee_id_order_fees_id_fk" FOREIGN KEY ("order_fee_id") REFERENCES "public"."order_fees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_completed_by_user_id_admin_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_items_item_uq" ON "refund_items" USING btree ("refund_id","order_item_id") WHERE "refund_items"."order_item_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_items_fee_uq" ON "refund_items" USING btree ("refund_id","order_fee_id") WHERE "refund_items"."order_fee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "refund_items_fee_idx" ON "refund_items" USING btree ("order_fee_id");--> statement-breakpoint
CREATE INDEX "refunds_open_idx" ON "refunds" USING btree ("created_at") WHERE "refunds"."status" IN ('PENDING','FAILED');--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_target" CHECK (("refund_items"."order_item_id" IS NOT NULL)::int + ("refund_items"."order_fee_id" IS NOT NULL)::int = 1);