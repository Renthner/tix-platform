ALTER TYPE "public"."scan_result" ADD VALUE 'REJECTED_CHECK_OUT_NOT_ALLOWED';--> statement-breakpoint
ALTER TYPE "public"."scan_warning" ADD VALUE 'ADDITIONAL_PAYMENT_OPEN';--> statement-breakpoint
CREATE TABLE "device_pairing_code_events" (
	"code_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"entrance_id" uuid,
	"allow_check_out" boolean DEFAULT true NOT NULL,
	CONSTRAINT "device_pairing_code_events_pk" PRIMARY KEY("code_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "event_scanner_secrets" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"lan_secret_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scanner_apk_releases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version_name" text NOT NULL,
	"version_code" integer NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"notes" text,
	"uploaded_by_user_id" uuid,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scanner_apk_releases_version_code_uq" UNIQUE("version_code"),
	CONSTRAINT "scanner_apk_releases_version_code_pos" CHECK ("scanner_apk_releases"."version_code" > 0)
);
--> statement-breakpoint
CREATE TABLE "scanner_sync_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"sync_epoch" text NOT NULL,
	CONSTRAINT "scanner_sync_state_singleton" CHECK ("scanner_sync_state"."id")
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "sync_xid" xid8 DEFAULT '0'::xid8 NOT NULL;--> statement-breakpoint
ALTER TABLE "device_pairing_code_events" ADD CONSTRAINT "device_pairing_code_events_code_id_device_pairing_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."device_pairing_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_code_events" ADD CONSTRAINT "device_pairing_code_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_code_events" ADD CONSTRAINT "device_pairing_code_events_entrance_id_seat_map_entrances_id_fk" FOREIGN KEY ("entrance_id") REFERENCES "public"."seat_map_entrances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_scanner_secrets" ADD CONSTRAINT "event_scanner_secrets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_apk_releases" ADD CONSTRAINT "scanner_apk_releases_uploaded_by_user_id_admin_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scanner_apk_releases_single_current_uq" ON "scanner_apk_releases" USING btree ("is_current") WHERE "scanner_apk_releases"."is_current";--> statement-breakpoint
CREATE INDEX "tickets_event_sync_xid_idx" ON "tickets" USING btree ("event_id","sync_xid","id");
--> statement-breakpoint
INSERT INTO "scanner_sync_state" ("id", "sync_epoch") VALUES (true, gen_random_uuid()::text);
--> statement-breakpoint
-- Existing tickets get xid 0 (no table rewrite); new rows and every bump use the writing transaction.
ALTER TABLE "tickets" ALTER COLUMN "sync_xid" SET DEFAULT pg_current_xact_id();
--> statement-breakpoint
-- Scanner delta sync: next to every sync_version bump store the writing transaction id (xid8).
-- The delta cursor is the xid horizon (pg_snapshot_xmin), so rows that commit late are never
-- skipped. Updates that only touch generated file references (PDF, pass keys) and updated_at do
-- not bump. An explicit `SET sync_version = 0` (see the touch triggers below) always bumps.
CREATE OR REPLACE FUNCTION tickets_bump_sync_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sync_version IS NOT DISTINCT FROM OLD.sync_version
     AND (to_jsonb(NEW) - ARRAY['pdf_object_key', 'pkpass_object_key', 'google_wallet_object_id', 'updated_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['pdf_object_key', 'pkpass_object_key', 'google_wallet_object_id', 'updated_at'])
  THEN
    RETURN NEW;
  END IF;
  NEW.sync_version := nextval('ticket_sync_version_seq');
  NEW.sync_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- What the scanner shows lives partly outside `tickets`. Touching the ticket row (sync_version = 0
-- is replaced by a fresh value by the trigger above) makes devices re-fetch it when
--  * an additional payment (tariff change) opens, is confirmed, settles or is cancelled,
--  * the order item seat / tariff / category / attendee snapshot changes,
--  * a seat becomes or stops being a wheelchair space / companion seat.
CREATE OR REPLACE FUNCTION order_adjustments_touch_tickets() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tickets t SET sync_version = 0
  WHERE t.order_id = NEW.order_id
    AND t.status = 'VALID'
    AND t.order_item_id IN (
      SELECT (e->>'orderItemId')::uuid FROM jsonb_array_elements(NEW.items) AS e
      UNION
      SELECT (e->>'orderItemId')::uuid FROM jsonb_array_elements(
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.items ELSE '[]'::jsonb END
      ) AS e
    );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_adjustments_touch_tickets
  AFTER INSERT OR UPDATE OF status, items ON "order_adjustments"
  FOR EACH ROW EXECUTE FUNCTION order_adjustments_touch_tickets();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION order_items_touch_tickets() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tickets SET sync_version = 0 WHERE order_item_id = NEW.id AND status = 'VALID';
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_items_touch_tickets
  AFTER UPDATE ON "order_items"
  FOR EACH ROW
  WHEN (
    OLD.attendee_name IS DISTINCT FROM NEW.attendee_name
    OR OLD.seat_id IS DISTINCT FROM NEW.seat_id
    OR OLD.section_id IS DISTINCT FROM NEW.section_id
    OR OLD.price_category_id IS DISTINCT FROM NEW.price_category_id
    OR OLD.ticket_type_id IS DISTINCT FROM NEW.ticket_type_id
    OR OLD.section_label IS DISTINCT FROM NEW.section_label
    OR OLD.row_label IS DISTINCT FROM NEW.row_label
    OR OLD.seat_label IS DISTINCT FROM NEW.seat_label
    OR OLD.category_name IS DISTINCT FROM NEW.category_name
    OR OLD.ticket_type_name IS DISTINCT FROM NEW.ticket_type_name
  )
  EXECUTE FUNCTION order_items_touch_tickets();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION seats_touch_tickets() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tickets SET sync_version = 0
  WHERE status = 'VALID'
    AND order_item_id IN (SELECT id FROM order_items WHERE seat_id = NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER seats_touch_tickets
  AFTER UPDATE OF is_wheelchair_space, is_companion_seat ON "seats"
  FOR EACH ROW
  WHEN (
    OLD.is_wheelchair_space IS DISTINCT FROM NEW.is_wheelchair_space
    OR OLD.is_companion_seat IS DISTINCT FROM NEW.is_companion_seat
  )
  EXECUTE FUNCTION seats_touch_tickets();
