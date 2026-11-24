-- 1) Duplicate redemptions of one code by one session (a race in the old check-then-insert):
--    keep the earliest row, delete the rest and give the double-counted uses back to the code.
-- Block concurrent redemptions while the duplicates are removed and the unique index is built.
LOCK TABLE "access_code_redemptions" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
WITH ranked AS (
  SELECT "id", "access_code_id",
         row_number() OVER (
           PARTITION BY "access_code_id", "session_id"
           ORDER BY ("order_id" IS NULL), "redeemed_at", "id"
         ) AS rn
  FROM "access_code_redemptions"
  WHERE "session_id" IS NOT NULL
),
removed AS (
  DELETE FROM "access_code_redemptions" r
  USING ranked
  WHERE r."id" = ranked."id" AND ranked.rn > 1
  RETURNING r."access_code_id"
),
per_code AS (
  SELECT "access_code_id", count(*)::integer AS n FROM removed GROUP BY "access_code_id"
)
UPDATE "access_codes" c
SET "redemption_count" = GREATEST(c."redemption_count" - per_code.n, 0)
FROM per_code
WHERE c."id" = per_code."access_code_id";--> statement-breakpoint
CREATE UNIQUE INDEX "access_code_redemptions_code_session_uq" ON "access_code_redemptions" USING btree ("access_code_id","session_id");--> statement-breakpoint
-- 2) Guest order access links carry this version; an admin reset bumps it (old links stop working).
ALTER TABLE "orders" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;
