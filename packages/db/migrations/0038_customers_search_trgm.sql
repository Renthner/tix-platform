CREATE INDEX "customers_email_trgm_idx" ON "customers" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_phone_trgm_idx" ON "customers" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_name_rev_trgm_idx" ON "customers" USING gin (("last_name" || ' ' || "first_name") gin_trgm_ops);