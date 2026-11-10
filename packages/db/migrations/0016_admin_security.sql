ALTER TYPE "public"."email_template_key" ADD VALUE 'ADMIN_INVITE';--> statement-breakpoint
ALTER TYPE "public"."email_template_key" ADD VALUE 'ADMIN_PASSWORD_RESET';--> statement-breakpoint
CREATE TABLE "admin_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_tokens_purpose_valid" CHECK ("admin_tokens"."purpose" IN ('INVITE', 'PASSWORD_RESET'))
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_pending_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_recovery_codes_uq" ON "admin_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_tokens_hash_uq" ON "admin_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_tokens_user_idx" ON "admin_tokens" USING btree ("user_id","purpose");