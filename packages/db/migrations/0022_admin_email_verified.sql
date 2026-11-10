ALTER TABLE "admin_tokens" DROP CONSTRAINT "admin_tokens_purpose_valid";--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD COLUMN "linked_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_linked_admin_user_id_admin_users_id_fk" FOREIGN KEY ("linked_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_purpose_valid" CHECK ("admin_tokens"."purpose" IN ('INVITE', 'PASSWORD_RESET', 'EMAIL_VERIFY'));