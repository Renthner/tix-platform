-- Erasure ledger lives in its own schema: excluded from backups, untouched by restores.
-- Idempotent on purpose (a restore can bring back an older migration level while the schema exists).
CREATE SCHEMA IF NOT EXISTS "retained";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retained"."erasures" (
	"customer_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"erased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasures_customer_scope_uq" UNIQUE("customer_id","scope")
);
--> statement-breakpoint
-- Backfill: customers anonymised before the ledger existed (idempotent; also re-runs after a restore
-- from an older backup that predates this migration).
INSERT INTO "retained"."erasures" ("customer_id", "scope", "erased_at")
SELECT "id", 'CUSTOMER', "anonymized_at" FROM "public"."customers" WHERE "anonymized_at" IS NOT NULL
ON CONFLICT ("customer_id", "scope") DO NOTHING;
