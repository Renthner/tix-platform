-- Hardening: qualify the sequence in the ticket sync trigger. An unqualified nextval() fails with
-- "relation does not exist" whenever the session search_path is empty (e.g. inside a pg_restore
-- script). Body identical to 0028_scanner_api.sql except for the schema-qualified sequence.
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
  NEW.sync_version := nextval('public.ticket_sync_version_seq');
  NEW.sync_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;
