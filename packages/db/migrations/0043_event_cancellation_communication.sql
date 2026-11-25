ALTER TYPE "public"."email_template_key" ADD VALUE 'EVENT_CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'EVENT_POSTPONED';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ORDER_MESSAGE';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'EVENT_MESSAGE';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ORDER_EMAIL_CHANGED';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ORDER_EMAIL_CHANGED_OLD';--> statement-breakpoint
CREATE TABLE "event_cancellation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"refund_fees" boolean DEFAULT true NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"reason" text,
	"started_by_user_id" uuid,
	"total_orders" integer DEFAULT 0 NOT NULL,
	"cancelled_orders" integer DEFAULT 0 NOT NULL,
	"manual_orders" integer DEFAULT 0 NOT NULL,
	"failed_orders" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_cancellation_runs_status_chk" CHECK ("event_cancellation_runs"."status" IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'))
);
--> statement-breakpoint
CREATE TABLE "event_mailing_recipients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mailing_id" uuid NOT NULL,
	"email_key" text NOT NULL,
	"order_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_mailings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text DEFAULT 'EVENT_MESSAGE' NOT NULL,
	"audience" text NOT NULL,
	"category_id" uuid,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_mailings_status_chk" CHECK ("event_mailings"."status" IN ('RUNNING', 'COMPLETED')),
	CONSTRAINT "event_mailings_kind_chk" CHECK ("event_mailings"."kind" IN ('EVENT_MESSAGE', 'EVENT_POSTPONED')),
	CONSTRAINT "event_mailings_audience_chk" CHECK ("event_mailings"."audience" IN ('PAID', 'ACTIVE', 'CATEGORY'))
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "postponed_new_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "postponement_note" text;--> statement-breakpoint
ALTER TABLE "event_cancellation_runs" ADD CONSTRAINT "event_cancellation_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_cancellation_runs" ADD CONSTRAINT "event_cancellation_runs_started_by_user_id_admin_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_mailing_recipients" ADD CONSTRAINT "event_mailing_recipients_mailing_id_event_mailings_id_fk" FOREIGN KEY ("mailing_id") REFERENCES "public"."event_mailings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_mailing_recipients" ADD CONSTRAINT "event_mailing_recipients_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_mailing_recipients" ADD CONSTRAINT "event_mailing_recipients_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_mailings" ADD CONSTRAINT "event_mailings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_mailings" ADD CONSTRAINT "event_mailings_category_id_price_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_mailings" ADD CONSTRAINT "event_mailings_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_cancellation_runs_one_running_uq" ON "event_cancellation_runs" USING btree ("event_id") WHERE "event_cancellation_runs"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "event_cancellation_runs_event_idx" ON "event_cancellation_runs" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_mailing_recipients_uq" ON "event_mailing_recipients" USING btree ("mailing_id","email_key");--> statement-breakpoint
CREATE INDEX "event_mailings_event_idx" ON "event_mailings" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "event_mailings_running_idx" ON "event_mailings" USING btree ("status") WHERE "event_mailings"."status" = 'RUNNING';