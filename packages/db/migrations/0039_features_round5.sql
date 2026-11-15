CREATE TYPE "public"."discount_code_type" AS ENUM('FIXED', 'PERCENT');--> statement-breakpoint
CREATE TYPE "public"."ticket_change_actor" AS ENUM('CUSTOMER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."ticket_change_kind" AS ENUM('NAME_CHANGE', 'TRANSFER');--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'TICKET_TRANSFER_RECEIVED' BEFORE 'CUSTOMER_EMAIL_VERIFICATION';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'TICKET_TRANSFER_SENT' BEFORE 'CUSTOMER_EMAIL_VERIFICATION';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ADMIN_ALERT';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ADMIN_ALERT_RESOLVED';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'WAITLIST_CONFIRM';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'WAITLIST_AVAILABLE';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'WAITLIST_REMOVED';--> statement-breakpoint
CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"alert_key" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"send_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"new_ticket_id" uuid NOT NULL,
	"kind" "ticket_change_kind" NOT NULL,
	"actor" "ticket_change_actor" NOT NULL,
	"actor_user_id" uuid,
	"old_name" text,
	"new_name" text,
	"recipient_email" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"type" "discount_code_type" NOT NULL,
	"value" integer NOT NULL,
	"all_events" boolean DEFAULT true NOT NULL,
	"event_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"ticket_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"max_total_uses" integer,
	"max_uses_per_email" integer,
	"min_order_value" integer,
	"discount_fees" boolean DEFAULT false NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"batch_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_codes_code_format" CHECK ("discount_codes"."code" ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
	CONSTRAINT "discount_codes_value" CHECK ("discount_codes"."value" > 0 AND ("discount_codes"."type" <> 'PERCENT' OR "discount_codes"."value" <= 10000)),
	CONSTRAINT "discount_codes_limits" CHECK (("discount_codes"."max_total_uses" IS NULL OR "discount_codes"."max_total_uses" > 0)
        AND ("discount_codes"."max_uses_per_email" IS NULL OR "discount_codes"."max_uses_per_email" > 0)
        AND ("discount_codes"."min_order_value" IS NULL OR "discount_codes"."min_order_value" >= 0)),
	CONSTRAINT "discount_codes_validity" CHECK ("discount_codes"."valid_from" IS NULL OR "discount_codes"."valid_until" IS NULL OR "discount_codes"."valid_from" < "discount_codes"."valid_until")
);
--> statement-breakpoint
CREATE TABLE "order_discounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"discount_code_id" uuid NOT NULL,
	"code" text NOT NULL,
	"type" "discount_code_type" NOT NULL,
	"value" integer NOT NULL,
	"amount" integer NOT NULL,
	"fee_amount" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_discounts_amounts" CHECK ("order_discounts"."amount" > 0 AND "order_discounts"."fee_amount" >= 0 AND "order_discounts"."fee_amount" <= "order_discounts"."amount")
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"category_id" uuid,
	"quantity" integer DEFAULT 2 NOT NULL,
	"locale" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmation_sent_at" timestamp with time zone,
	"armed" boolean DEFAULT true NOT NULL,
	"last_notified_at" timestamp with time zone,
	"notified_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_quantity_range" CHECK ("waitlist_entries"."quantity" BETWEEN 1 AND 50)
);
--> statement-breakpoint
-- Idempotent: the retained schema survives restores (see 0019).
CREATE TABLE IF NOT EXISTS "retained"."waitlist_removals" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_fees" DROP CONSTRAINT "order_fees_amounts";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_amounts_nonneg";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_price_consistent";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_amounts_nonneg";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_total_consistent";--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "alert_preferences" jsonb;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "waitlist_enabled" boolean;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "self_service_enabled" boolean;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "self_service_allow_name_change" boolean;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "self_service_allow_transfer" boolean;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "self_service_deadline_hours" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "self_service_max_changes" integer;--> statement-breakpoint
ALTER TABLE "order_fees" ADD COLUMN "code_discount_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "code_discount_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "code_discount_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "holder_email" text;--> statement-breakpoint
ALTER TABLE "ticket_changes" ADD CONSTRAINT "ticket_changes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_changes" ADD CONSTRAINT "ticket_changes_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_changes" ADD CONSTRAINT "ticket_changes_actor_user_id_admin_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_discount_code_id_discount_codes_id_fk" FOREIGN KEY ("discount_code_id") REFERENCES "public"."discount_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_category_id_price_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_alerts_open_key_uq" ON "admin_alerts" USING btree ("alert_key") WHERE "admin_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "admin_alerts_first_seen_idx" ON "admin_alerts" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "ticket_changes_order_idx" ON "ticket_changes" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_changes_item_idx" ON "ticket_changes" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_codes_code_uq" ON "discount_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "discount_codes_batch_idx" ON "discount_codes" USING btree ("batch_id") WHERE "discount_codes"."batch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_discounts_order_code_uq" ON "order_discounts" USING btree ("order_id","discount_code_id");--> statement-breakpoint
CREATE INDEX "order_discounts_code_idx" ON "order_discounts" USING btree ("discount_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_event_email_uq" ON "waitlist_entries" USING btree ("event_id",lower("email"));--> statement-breakpoint
CREATE INDEX "waitlist_entries_event_idx" ON "waitlist_entries" USING btree ("event_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "waitlist_entries_email_idx" ON "waitlist_entries" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_amounts" CHECK ("order_fees"."unit_amount_gross" >= 0 AND "order_fees"."code_discount_amount" >= 0 AND "order_fees"."total_gross" >= 0 AND "order_fees"."total_net" >= 0 AND "order_fees"."total_tax" >= 0
        AND "order_fees"."total_gross" = "order_fees"."total_net" + "order_fees"."total_tax");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts_nonneg" CHECK ("order_items"."unit_price_gross" >= 0 AND "order_items"."discount_amount" >= 0 AND "order_items"."code_discount_amount" >= 0 AND "order_items"."price_gross" >= 0
        AND "order_items"."price_net" >= 0 AND "order_items"."tax_amount" >= 0);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_consistent" CHECK ("order_items"."price_gross" = "order_items"."unit_price_gross" - "order_items"."discount_amount" - "order_items"."code_discount_amount");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_nonneg" CHECK ("orders"."subtotal_gross" >= 0 AND "orders"."discount_total" >= 0 AND "orders"."code_discount_total" >= 0 AND "orders"."fee_total" >= 0
        AND "orders"."total_gross" >= 0 AND "orders"."total_net" >= 0 AND "orders"."total_tax" >= 0
        AND "orders"."amount_paid" >= 0 AND "orders"."amount_refunded" >= 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_consistent" CHECK ("orders"."total_gross" = "orders"."subtotal_gross" - "orders"."discount_total" - "orders"."code_discount_total" + "orders"."fee_total");
--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'TICKET_HOLDER_UPDATED' BEFORE 'CUSTOMER_EMAIL_VERIFICATION';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'TICKET_HOLDER_CANCELLED' BEFORE 'CUSTOMER_EMAIL_VERIFICATION';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'FREE';--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "code_discount_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "ticket_changes_recipient_idx" ON "ticket_changes" USING btree ("recipient_email","created_at");
