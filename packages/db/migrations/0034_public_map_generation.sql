CREATE SEQUENCE "public"."public_map_generation_seq" START WITH 2;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "public_map_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.price_category_bump_public_map_ins() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT DISTINCT t.event_id FROM new_rows t);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.price_category_bump_public_map_upd() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT n.event_id FROM new_rows n UNION SELECT o.event_id FROM old_rows o);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.price_category_bump_public_map_del() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT DISTINCT t.event_id FROM old_rows t);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ticket_type_bump_public_map_ins() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT DISTINCT t.event_id FROM new_rows t);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ticket_type_bump_public_map_upd() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT n.event_id FROM new_rows n UNION SELECT o.event_id FROM old_rows o);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ticket_type_bump_public_map_del() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT DISTINCT t.event_id FROM old_rows t);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.price_matrix_bump_public_map_ins() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT pc.event_id FROM public.price_categories pc WHERE pc.id IN (SELECT t.price_category_id FROM new_rows t));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.price_matrix_bump_public_map_upd() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT pc.event_id FROM public.price_categories pc
      WHERE pc.id IN (SELECT n.price_category_id FROM new_rows n UNION SELECT o.price_category_id FROM old_rows o));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.price_matrix_bump_public_map_del() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.events SET public_map_generation = nextval('public.public_map_generation_seq')
    WHERE id IN (SELECT pc.event_id FROM public.price_categories pc WHERE pc.id IN (SELECT t.price_category_id FROM old_rows t));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.events_currency_bump_public_map() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.public_map_generation = nextval('public.public_map_generation_seq');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_categories_bump_public_map_ins
  AFTER INSERT ON "price_categories"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.price_category_bump_public_map_ins();
--> statement-breakpoint
CREATE TRIGGER price_categories_bump_public_map_upd
  AFTER UPDATE ON "price_categories"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.price_category_bump_public_map_upd();
--> statement-breakpoint
CREATE TRIGGER price_categories_bump_public_map_del
  AFTER DELETE ON "price_categories"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.price_category_bump_public_map_del();
--> statement-breakpoint
CREATE TRIGGER ticket_types_bump_public_map_ins
  AFTER INSERT ON "ticket_types"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.ticket_type_bump_public_map_ins();
--> statement-breakpoint
CREATE TRIGGER ticket_types_bump_public_map_upd
  AFTER UPDATE ON "ticket_types"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.ticket_type_bump_public_map_upd();
--> statement-breakpoint
CREATE TRIGGER ticket_types_bump_public_map_del
  AFTER DELETE ON "ticket_types"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.ticket_type_bump_public_map_del();
--> statement-breakpoint
CREATE TRIGGER price_category_ticket_types_bump_public_map_ins
  AFTER INSERT ON "price_category_ticket_types"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.price_matrix_bump_public_map_ins();
--> statement-breakpoint
CREATE TRIGGER price_category_ticket_types_bump_public_map_upd
  AFTER UPDATE ON "price_category_ticket_types"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.price_matrix_bump_public_map_upd();
--> statement-breakpoint
CREATE TRIGGER price_category_ticket_types_bump_public_map_del
  AFTER DELETE ON "price_category_ticket_types"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.price_matrix_bump_public_map_del();
--> statement-breakpoint
CREATE TRIGGER events_currency_bump_public_map
  BEFORE UPDATE OF currency ON "events"
  FOR EACH ROW WHEN (OLD.currency IS DISTINCT FROM NEW.currency)
  EXECUTE FUNCTION public.events_currency_bump_public_map();
