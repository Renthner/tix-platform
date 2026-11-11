CREATE TABLE "refund_reconcile_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"token" text,
	"reason" text,
	"since" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"unchecked" integer DEFAULT 0 NOT NULL,
	"alert" text,
	CONSTRAINT "refund_reconcile_state_singleton" CHECK ("refund_reconcile_state"."id")
);
