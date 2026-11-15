CREATE TABLE "admin_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[],
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "admin_passkeys_counter_nonneg" CHECK ("admin_passkeys"."counter" >= 0),
	CONSTRAINT "admin_passkeys_name_len" CHECK (char_length("admin_passkeys"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_passkeys_credential_uq" ON "admin_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "admin_passkeys_user_idx" ON "admin_passkeys" USING btree ("admin_user_id");--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ADMIN_PASSKEY_ADDED';