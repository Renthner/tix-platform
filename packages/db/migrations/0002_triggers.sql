-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Ticket change counter for Android delta sync.
--    Every UPDATE (status, check-in state, attendee name …) assigns a fresh value from
--    ticket_sync_version_seq; scanners pull `WHERE event_id = $1 AND sync_version > $last`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tickets_bump_sync_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_version := nextval('ticket_sync_version_seq');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tickets_bump_sync_version
  BEFORE UPDATE ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION tickets_bump_sync_version();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) GoBD: issued invoices / credit notes are immutable.
--    Only the asynchronously rendered PDF reference may be set once. Corrections are made
--    exclusively by issuing a CREDIT_NOTE that references the original invoice.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoices_guard_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice % is immutable and cannot be deleted', OLD.invoice_number
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.pdf_object_key IS NOT NULL AND NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key THEN
    RAISE EXCEPTION 'invoice % already has a rendered PDF', OLD.invoice_number
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'pdf_object_key') IS DISTINCT FROM (to_jsonb(OLD) - 'pdf_object_key') THEN
    RAISE EXCEPTION 'invoice % is immutable; issue a credit note instead', OLD.invoice_number
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard_immutable
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_guard_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invoice_lines_guard_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice lines are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_guard_immutable
  BEFORE UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard_immutable();
