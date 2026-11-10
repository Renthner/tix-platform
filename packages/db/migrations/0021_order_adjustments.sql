CREATE TYPE "public"."adjustment_kind" AS ENUM('TARIFF_UPGRADE');--> statement-breakpoint
CREATE TYPE "public"."adjustment_status" AS ENUM('PROPOSED', 'CONFIRMED', 'PAID', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ADDITIONAL_PAYMENT_REQUEST' BEFORE 'TICKETS_RESENT';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ADDITIONAL_PAYMENT_REMINDER' BEFORE 'TICKETS_RESENT';--> statement-breakpoint
CREATE TABLE "order_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "adjustment_status" DEFAULT 'PROPOSED' NOT NULL,
	"kind" "adjustment_kind" DEFAULT 'TARIFF_UPGRADE' NOT NULL,
	"amount" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"payment_reference" text NOT NULL,
	"items" jsonb NOT NULL,
	"reason" text,
	"created_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_adjustments_payment_reference_uq" UNIQUE("payment_reference"),
	CONSTRAINT "order_adjustments_amount_positive" CHECK ("order_adjustments"."amount" > 0),
	CONSTRAINT "order_adjustments_currency_format" CHECK ("order_adjustments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "order_adjustments_reference_format" CHECK ("order_adjustments"."payment_reference" ~ '^[A-Z]{2,6}-[0-9]{4}-[0-9]{4,10}-[0-9]$')
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "adjustment_id" uuid;--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_adjustments_order_idx" ON "order_adjustments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_adjustments_one_open_uq" ON "order_adjustments" USING btree ("order_id") WHERE "order_adjustments"."status" IN ('PROPOSED','CONFIRMED');--> statement-breakpoint
CREATE INDEX "order_adjustments_open_idx" ON "order_adjustments" USING btree ("created_at") WHERE "order_adjustments"."status" IN ('PROPOSED','CONFIRMED');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_adjustment_id_order_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."order_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_adjustment_idx" ON "payments" USING btree ("adjustment_id") WHERE "payments"."adjustment_id" IS NOT NULL;