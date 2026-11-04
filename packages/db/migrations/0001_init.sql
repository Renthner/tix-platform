CREATE TYPE "public"."access_code_type" AS ENUM('SINGLE_USE', 'MULTI_USE');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'WEBHOOK', 'DEVICE');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('SUPER_ADMIN', 'EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF');--> statement-breakpoint
CREATE TYPE "public"."allocation_method" AS ENUM('AUTO', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."announcement_severity" AS ENUM('INFO', 'WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."bank_adapter" AS ENUM('FINTS', 'PSD2_GOCARDLESS', 'PSD2_FINAPI', 'FILE_IMPORT', 'IMAP');--> statement-breakpoint
CREATE TYPE "public"."bank_import_source" AS ENUM('UPLOAD', 'IMAP', 'FINTS', 'PSD2');--> statement-breakpoint
CREATE TYPE "public"."bank_import_status" AS ENUM('PROCESSING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."bank_statement_format" AS ENUM('CAMT052', 'CAMT053', 'MT940', 'CSV');--> statement-breakpoint
CREATE TYPE "public"."bank_sync_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'TAN_REQUIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."bank_sync_trigger" AS ENUM('SCHEDULED', 'MANUAL', 'UPLOAD', 'IMAP');--> statement-breakpoint
CREATE TYPE "public"."bank_tx_match_status" AS ENUM('UNMATCHED', 'AUTO_MATCHED', 'MANUALLY_MATCHED', 'NEEDS_REVIEW', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."bank_tx_review_reason" AS ENUM('NO_REFERENCE', 'UNKNOWN_REFERENCE', 'UNDERPAYMENT', 'OVERPAYMENT', 'ORDER_NOT_PAYABLE', 'AMBIGUOUS', 'NAME_MATCH_ONLY', 'CURRENCY_MISMATCH');--> statement-breakpoint
CREATE TYPE "public"."check_in_state" AS ENUM('NONE', 'CHECKED_IN', 'CHECKED_OUT');--> statement-breakpoint
CREATE TYPE "public"."customer_token_purpose" AS ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'LOGIN_LINK');--> statement-breakpoint
CREATE TYPE "public"."discount_kind" AS ENUM('NONE', 'PERCENT', 'FIXED_AMOUNT', 'FIXED_PRICE');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('QUEUED', 'SENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."email_template_key" AS ENUM('ORDER_CONFIRMATION_BANK_TRANSFER', 'PAYMENT_RECEIVED_TICKETS', 'PAYMENT_REMINDER', 'ORDER_CANCELLED', 'REFUND_CONFIRMATION', 'TICKETS_RESENT', 'CUSTOMER_EMAIL_VERIFICATION', 'CUSTOMER_PASSWORD_RESET', 'CUSTOMER_LOGIN_LINK', 'SMTP_TEST');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('DRAFT', 'PUBLISHED', 'POSTPONED', 'CANCELLED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."fee_calculation" AS ENUM('FIXED', 'PERCENT');--> statement-breakpoint
CREATE TYPE "public"."fee_scope" AS ENUM('PER_TICKET', 'PER_EVENT', 'PER_ORDER');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('INVOICE', 'CREDIT_NOTE');--> statement-breakpoint
CREATE TYPE "public"."media_asset_kind" AS ENUM('EVENT_IMAGE', 'VENUE_BACKGROUND', 'TICKET_BACKGROUND', 'LOGO', 'WALLET_IMAGE', 'EMAIL_IMAGE', 'DOCUMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."order_item_kind" AS ENUM('SEAT', 'GENERAL_ADMISSION');--> statement-breakpoint
CREATE TYPE "public"."order_item_status" AS ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('PAYPAL', 'BANK_TRANSFER', 'CASH', 'CARD', 'COMPLIMENTARY');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'APPROVED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."queue_admission_order" AS ENUM('FIFO', 'RANDOMIZED');--> statement-breakpoint
CREATE TYPE "public"."queue_mode" AS ENUM('OFF', 'AUTO_THRESHOLD', 'SCHEDULED_PRE_REGISTRATION', 'VIP_CODE_ONLY', 'HYBRID');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."sales_channel" AS ENUM('ONLINE', 'BOX_OFFICE', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."scan_action" AS ENUM('CHECK_IN', 'CHECK_OUT');--> statement-breakpoint
CREATE TYPE "public"."scan_result" AS ENUM('ACCEPTED', 'ACCEPTED_WITH_WARNING', 'REJECTED_ALREADY_CHECKED_IN', 'REJECTED_NOT_CHECKED_IN', 'REJECTED_INVALID_SIGNATURE', 'REJECTED_WRONG_EVENT', 'REJECTED_TICKET_VOID', 'REJECTED_UNKNOWN_TICKET', 'REJECTED_MALFORMED');--> statement-breakpoint
CREATE TYPE "public"."scan_source" AS ENUM('CAMERA', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."scan_warning" AS ENUM('DISCOUNT_PROOF_REQUIRED', 'WRONG_ENTRANCE', 'SEAT_FEATURE');--> statement-breakpoint
CREATE TYPE "public"."seat_block_reason" AS ENUM('PRESS', 'VIP', 'TECHNICAL', 'ARTIST', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."seat_feature" AS ENUM('WHEELCHAIR_SPACE', 'COMPANION_SEAT');--> statement-breakpoint
CREATE TYPE "public"."seat_map_element_type" AS ENUM('STAGE', 'TABLE', 'TEXT', 'SHAPE', 'LINE', 'IMAGE', 'EXIT', 'FACILITY');--> statement-breakpoint
CREATE TYPE "public"."seat_map_kind" AS ENUM('TEMPLATE', 'EVENT');--> statement-breakpoint
CREATE TYPE "public"."section_type" AS ENUM('SEATED', 'STANDING');--> statement-breakpoint
CREATE TYPE "public"."signing_key_status" AS ENUM('ACTIVE', 'RETIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."tan_challenge_status" AS ENUM('PENDING', 'SUBMITTED', 'COMPLETED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('VALID', 'CANCELLED', 'REFUNDED', 'REPLACED');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');--> statement-breakpoint
CREATE SEQUENCE "public"."ticket_sync_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"roles" "admin_role"[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"totp_secret_encrypted" text,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_roles_not_empty" CHECK (cardinality("admin_users"."roles") > 0),
	CONSTRAINT "admin_users_failed_login_count_nonneg" CHECK ("admin_users"."failed_login_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_device_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"changes" jsonb,
	"metadata" jsonb,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" "media_asset_kind" NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"alt_text" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_object_uq" UNIQUE("bucket","object_key"),
	CONSTRAINT "media_assets_size_nonneg" CHECK ("media_assets"."size_bytes" >= 0),
	CONSTRAINT "media_assets_dimensions_positive" CHECK (("media_assets"."width" IS NULL OR "media_assets"."width" > 0) AND ("media_assets"."height" IS NULL OR "media_assets"."height" > 0))
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"scope" text PRIMARY KEY NOT NULL,
	"last_value" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_sequences_nonneg" CHECK ("number_sequences"."last_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"encrypted_value" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_one_value" CHECK (num_nonnulls("system_settings"."value", "system_settings"."encrypted_value") = 1)
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"invoice_note" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_name_uq" UNIQUE("name"),
	CONSTRAINT "tax_rates_rate_range" CHECK ("tax_rates"."rate_basis_points" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "seat_map_elements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seat_map_id" uuid NOT NULL,
	"section_id" uuid,
	"type" "seat_map_element_type" NOT NULL,
	"label" text,
	"geometry" jsonb NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"asset_id" uuid,
	"z_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_map_elements_image_asset" CHECK ("seat_map_elements"."type" <> 'IMAGE' OR "seat_map_elements"."asset_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "seat_map_entrances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seat_map_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_map_entrances_code_uq" UNIQUE("seat_map_id","code")
);
--> statement-breakpoint
CREATE TABLE "seat_map_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seat_map_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"geometry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_map_rows_label_uq" UNIQUE("section_id","label")
);
--> statement-breakpoint
CREATE TABLE "seat_map_sections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seat_map_id" uuid NOT NULL,
	"type" "section_type" NOT NULL,
	"name" text NOT NULL,
	"ticket_label" text NOT NULL,
	"geometry" jsonb NOT NULL,
	"label" jsonb,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"entrance_id" uuid,
	"price_category_id" uuid,
	"capacity" integer,
	"allocated_count" integer DEFAULT 0 NOT NULL,
	"best_available_priority" integer DEFAULT 100 NOT NULL,
	"is_best_available_enabled" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_map_sections_name_uq" UNIQUE("seat_map_id","name"),
	CONSTRAINT "seat_map_sections_capacity_required" CHECK ("seat_map_sections"."type" <> 'STANDING' OR ("seat_map_sections"."capacity" IS NOT NULL AND "seat_map_sections"."capacity" >= 0)),
	CONSTRAINT "seat_map_sections_allocation_within_capacity" CHECK ("seat_map_sections"."allocated_count" >= 0 AND ("seat_map_sections"."capacity" IS NULL OR "seat_map_sections"."allocated_count" <= "seat_map_sections"."capacity")),
	CONSTRAINT "seat_map_sections_seated_no_allocation" CHECK ("seat_map_sections"."type" = 'STANDING' OR "seat_map_sections"."allocated_count" = 0)
);
--> statement-breakpoint
CREATE TABLE "seat_maps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_id" uuid NOT NULL,
	"kind" "seat_map_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cloned_from_id" uuid,
	"canvas_width" integer NOT NULL,
	"canvas_height" integer NOT NULL,
	"background_asset_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_maps_id_kind_uq" UNIQUE("id","kind"),
	CONSTRAINT "seat_maps_canvas_positive" CHECK ("seat_maps"."canvas_width" > 0 AND "seat_maps"."canvas_height" > 0),
	CONSTRAINT "seat_maps_version_positive" CHECK ("seat_maps"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seat_map_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"row_id" uuid,
	"table_element_id" uuid,
	"label" text NOT NULL,
	"position" integer,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"rotation" real DEFAULT 0 NOT NULL,
	"price_category_id" uuid,
	"best_available_rank" integer,
	"is_wheelchair_space" boolean DEFAULT false NOT NULL,
	"is_companion_seat" boolean DEFAULT false NOT NULL,
	"has_restricted_view" boolean DEFAULT false NOT NULL,
	"block_reason" "seat_block_reason",
	"block_note" text,
	"blocked_at" timestamp with time zone,
	"blocked_by_user_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seats_single_parent" CHECK ("seats"."row_id" IS NULL OR "seats"."table_element_id" IS NULL),
	CONSTRAINT "seats_position_required" CHECK (("seats"."row_id" IS NULL AND "seats"."table_element_id" IS NULL) OR "seats"."position" IS NOT NULL),
	CONSTRAINT "seats_block_consistency" CHECK (("seats"."block_reason" IS NULL) = ("seats"."blocked_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"street" text,
	"postal_code" text,
	"city" text,
	"country" text,
	"latitude" double precision,
	"longitude" double precision,
	"time_zone" text NOT NULL,
	"description" text,
	"website_url" text,
	"image_asset_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venues_slug_uq" UNIQUE("slug"),
	CONSTRAINT "venues_slug_format" CHECK ("venues"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "venues_latitude_range" CHECK ("venues"."latitude" IS NULL OR "venues"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "venues_longitude_range" CHECK ("venues"."longitude" IS NULL OR "venues"."longitude" BETWEEN -180 AND 180),
	CONSTRAINT "venues_country_format" CHECK ("venues"."country" IS NULL OR "venues"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "access_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"access_code_id" uuid NOT NULL,
	"order_id" uuid,
	"email" text,
	"session_id" text,
	"ticket_count" integer DEFAULT 0 NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_code_redemptions_ticket_count" CHECK ("access_code_redemptions"."ticket_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "access_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid,
	"code" text NOT NULL,
	"label" text,
	"type" "access_code_type" NOT NULL,
	"max_redemptions" integer,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"max_tickets_per_order" integer,
	"max_tickets_total" integer,
	"bypasses_queue" boolean DEFAULT true NOT NULL,
	"grants_presale_access" boolean DEFAULT true NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_codes_code_uq" UNIQUE NULLS NOT DISTINCT("event_id","code"),
	CONSTRAINT "access_codes_code_format" CHECK ("access_codes"."code" ~ '^[A-Z0-9-]{4,64}$'),
	CONSTRAINT "access_codes_single_use" CHECK ("access_codes"."type" <> 'SINGLE_USE' OR "access_codes"."max_redemptions" = 1),
	CONSTRAINT "access_codes_redemptions" CHECK ("access_codes"."redemption_count" >= 0 AND ("access_codes"."max_redemptions" IS NULL OR ("access_codes"."max_redemptions" > 0 AND "access_codes"."redemption_count" <= "access_codes"."max_redemptions"))),
	CONSTRAINT "access_codes_ticket_limits" CHECK (("access_codes"."max_tickets_per_order" IS NULL OR "access_codes"."max_tickets_per_order" > 0) AND ("access_codes"."max_tickets_total" IS NULL OR "access_codes"."max_tickets_total" > 0)),
	CONSTRAINT "access_codes_validity" CHECK ("access_codes"."valid_from" IS NULL OR "access_codes"."valid_until" IS NULL OR "access_codes"."valid_from" < "access_codes"."valid_until")
);
--> statement-breakpoint
CREATE TABLE "event_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"image_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_series_slug_uq" UNIQUE("slug"),
	CONSTRAINT "event_series_slug_format" CHECK ("event_series"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "event_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text DEFAULT 'Ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"status" "signing_key_status" DEFAULT 'ACTIVE' NOT NULL,
	"retired_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_signing_keys_key_id_uq" UNIQUE("event_id","key_id"),
	CONSTRAINT "event_signing_keys_algorithm" CHECK ("event_signing_keys"."algorithm" = 'Ed25519')
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"series_id" uuid,
	"venue_id" uuid NOT NULL,
	"seat_map_id" uuid,
	"seat_map_kind" "seat_map_kind" DEFAULT 'EVENT' NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"description" text,
	"status" "event_status" DEFAULT 'DRAFT' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"doors_open_at" timestamp with time zone,
	"time_zone" text NOT NULL,
	"hero_image_asset_id" uuid,
	"presale_starts_at" timestamp with time zone,
	"public_sale_starts_at" timestamp with time zone,
	"sale_ends_at" timestamp with time zone,
	"sales_paused" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"max_tickets_per_order" integer,
	"max_tickets_per_customer" integer,
	"cart_lock_ttl_seconds" integer,
	"payment_grace_seconds" integer,
	"manual_seat_selection_enabled" boolean,
	"best_available_enabled" boolean,
	"orphan_seat_rule_enabled" boolean,
	"paypal_enabled" boolean,
	"bank_transfer_enabled" boolean,
	"bank_transfer_payment_term_days" integer,
	"bank_transfer_reminder_after_days" integer,
	"bank_transfer_cancel_after_days" integer,
	"bank_transfer_disable_days_before_event" integer,
	"ticket_template_id" uuid,
	"google_wallet_class_id" text,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"cloned_from_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_uq" UNIQUE("slug"),
	CONSTRAINT "events_seat_map_uq" UNIQUE("seat_map_id"),
	CONSTRAINT "events_seat_map_kind_event" CHECK ("events"."seat_map_kind" = 'EVENT'),
	CONSTRAINT "events_slug_format" CHECK ("events"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "events_currency_format" CHECK ("events"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "events_published_has_seat_map" CHECK ("events"."status" = 'DRAFT' OR "events"."seat_map_id" IS NOT NULL),
	CONSTRAINT "events_ends_after_start" CHECK ("events"."ends_at" IS NULL OR "events"."ends_at" > "events"."starts_at"),
	CONSTRAINT "events_doors_before_start" CHECK ("events"."doors_open_at" IS NULL OR "events"."doors_open_at" <= "events"."starts_at"),
	CONSTRAINT "events_presale_before_public" CHECK ("events"."presale_starts_at" IS NULL OR "events"."public_sale_starts_at" IS NULL OR "events"."presale_starts_at" <= "events"."public_sale_starts_at"),
	CONSTRAINT "events_sale_window" CHECK ("events"."sale_ends_at" IS NULL OR "events"."sale_ends_at" > COALESCE("events"."public_sale_starts_at", "events"."presale_starts_at", '-infinity'::timestamptz)),
	CONSTRAINT "events_positive_overrides" CHECK (COALESCE("events"."max_tickets_per_order", 1) > 0
        AND COALESCE("events"."max_tickets_per_customer", 1) > 0
        AND COALESCE("events"."cart_lock_ttl_seconds", 1) > 0
        AND COALESCE("events"."payment_grace_seconds", 0) >= 0
        AND COALESCE("events"."bank_transfer_payment_term_days", 1) > 0
        AND COALESCE("events"."bank_transfer_reminder_after_days", 1) > 0
        AND COALESCE("events"."bank_transfer_cancel_after_days", 1) > 0
        AND COALESCE("events"."bank_transfer_disable_days_before_event", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "fees" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid,
	"overrides_fee_id" uuid,
	"name" text NOT NULL,
	"scope" "fee_scope" NOT NULL,
	"calculation" "fee_calculation" NOT NULL,
	"value" integer NOT NULL,
	"tax_rate_id" uuid,
	"payment_methods" "payment_method"[],
	"channels" "sales_channel"[],
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fees_value_nonneg" CHECK ("fees"."value" >= 0),
	CONSTRAINT "fees_percent_range" CHECK ("fees"."calculation" <> 'PERCENT' OR "fees"."value" <= 10000),
	CONSTRAINT "fees_per_order_global" CHECK ("fees"."scope" <> 'PER_ORDER' OR "fees"."event_id" IS NULL),
	CONSTRAINT "fees_per_order_tax_rate" CHECK ("fees"."scope" <> 'PER_ORDER' OR "fees"."tax_rate_id" IS NOT NULL),
	CONSTRAINT "fees_override_on_event" CHECK ("fees"."overrides_fee_id" IS NULL OR "fees"."event_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "price_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text NOT NULL,
	"base_price" integer NOT NULL,
	"max_tickets_per_order" integer,
	"ticket_template_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_categories_name_uq" UNIQUE("event_id","name"),
	CONSTRAINT "price_categories_price_nonneg" CHECK ("price_categories"."base_price" >= 0),
	CONSTRAINT "price_categories_color_format" CHECK ("price_categories"."color" ~ '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$'),
	CONSTRAINT "price_categories_max_per_order_positive" CHECK ("price_categories"."max_tickets_per_order" IS NULL OR "price_categories"."max_tickets_per_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "price_category_ticket_types" (
	"price_category_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"price_override" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_category_ticket_types_pk" PRIMARY KEY("price_category_id","ticket_type_id"),
	CONSTRAINT "price_category_ticket_types_override_nonneg" CHECK ("price_category_ticket_types"."price_override" IS NULL OR "price_category_ticket_types"."price_override" >= 0)
);
--> statement-breakpoint
CREATE TABLE "queue_announcements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid,
	"severity" "announcement_severity" DEFAULT 'INFO' NOT NULL,
	"message" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid,
	"mode" "queue_mode" DEFAULT 'OFF' NOT NULL,
	"active_session_threshold" integer NOT NULL,
	"admission_batch_size" integer NOT NULL,
	"admission_interval_seconds" integer NOT NULL,
	"pass_token_ttl_seconds" integer NOT NULL,
	"lobby_opens_minutes_before" integer DEFAULT 60 NOT NULL,
	"admission_order" "queue_admission_order" DEFAULT 'RANDOMIZED' NOT NULL,
	"access_code_bypasses_queue" boolean DEFAULT true NOT NULL,
	"max_queue_size" integer,
	"is_paused" boolean DEFAULT false NOT NULL,
	"title" text,
	"message" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_configs_event_uq" UNIQUE NULLS NOT DISTINCT("event_id"),
	CONSTRAINT "queue_configs_positive" CHECK ("queue_configs"."active_session_threshold" > 0 AND "queue_configs"."admission_batch_size" > 0
        AND "queue_configs"."admission_interval_seconds" > 0 AND "queue_configs"."pass_token_ttl_seconds" >= 60
        AND "queue_configs"."lobby_opens_minutes_before" >= 0
        AND ("queue_configs"."max_queue_size" IS NULL OR "queue_configs"."max_queue_size" > 0))
);
--> statement-breakpoint
CREATE TABLE "ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"discount_kind" "discount_kind" DEFAULT 'NONE' NOT NULL,
	"discount_value" integer DEFAULT 0 NOT NULL,
	"requires_proof_at_entry" boolean DEFAULT false NOT NULL,
	"scanner_warning" text,
	"required_seat_feature" "seat_feature",
	"max_per_order" integer,
	"channels" "sales_channel"[] DEFAULT ARRAY['ONLINE','BOX_OFFICE','ADMIN']::sales_channel[] NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_types_name_uq" UNIQUE("event_id","name"),
	CONSTRAINT "ticket_types_discount_nonneg" CHECK ("ticket_types"."discount_value" >= 0),
	CONSTRAINT "ticket_types_percent_range" CHECK ("ticket_types"."discount_kind" <> 'PERCENT' OR "ticket_types"."discount_value" <= 10000),
	CONSTRAINT "ticket_types_none_zero" CHECK ("ticket_types"."discount_kind" <> 'NONE' OR "ticket_types"."discount_value" = 0),
	CONSTRAINT "ticket_types_max_per_order_positive" CHECK ("ticket_types"."max_per_order" IS NULL OR "ticket_types"."max_per_order" > 0),
	CONSTRAINT "ticket_types_channels_not_empty" CHECK (cardinality("ticket_types"."channels") > 0),
	CONSTRAINT "ticket_types_proof_warning" CHECK (NOT "ticket_types"."requires_proof_at_entry" OR "ticket_types"."scanner_warning" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "customer_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"customer_id" uuid NOT NULL,
	"purpose" "customer_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tokens_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"company" text,
	"phone" text,
	"address" jsonb,
	"locale" text,
	"marketing_consent_at" timestamp with time zone,
	"password_hash" text,
	"account_created_at" timestamp with time zone,
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_account_created" CHECK ("customers"."password_hash" IS NULL OR "customers"."account_created_at" IS NOT NULL),
	CONSTRAINT "customers_failed_login_count_nonneg" CHECK ("customers"."failed_login_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"service_date" timestamp with time zone,
	"quantity" integer NOT NULL,
	"unit_price_gross" integer NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"total_net" integer NOT NULL,
	"total_tax" integer NOT NULL,
	"total_gross" integer NOT NULL,
	"order_item_id" uuid,
	"order_fee_id" uuid,
	CONSTRAINT "invoice_lines_position_uq" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_lines_quantity_nonzero" CHECK ("invoice_lines"."quantity" <> 0),
	CONSTRAINT "invoice_lines_totals" CHECK ("invoice_lines"."total_gross" = "invoice_lines"."total_net" + "invoice_lines"."total_tax")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" "invoice_type" NOT NULL,
	"invoice_number" text NOT NULL,
	"corrects_invoice_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"currency" char(3) NOT NULL,
	"total_net" integer NOT NULL,
	"total_tax" integer NOT NULL,
	"total_gross" integer NOT NULL,
	"tax_breakdown" jsonb NOT NULL,
	"legal_notes" text,
	"pdf_object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_uq" UNIQUE("invoice_number"),
	CONSTRAINT "invoices_credit_note_reference" CHECK (("invoices"."type" = 'CREDIT_NOTE') = ("invoices"."corrects_invoice_id" IS NOT NULL)),
	CONSTRAINT "invoices_totals" CHECK ("invoices"."total_gross" = "invoices"."total_net" + "invoices"."total_tax")
);
--> statement-breakpoint
CREATE TABLE "order_fees" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" uuid,
	"fee_id" uuid,
	"name" text NOT NULL,
	"scope" "fee_scope" NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount_gross" integer NOT NULL,
	"total_gross" integer NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"total_net" integer NOT NULL,
	"total_tax" integer NOT NULL,
	"is_refunded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_fees_quantity_positive" CHECK ("order_fees"."quantity" > 0),
	CONSTRAINT "order_fees_event_scope" CHECK (("order_fees"."scope" = 'PER_ORDER') = ("order_fees"."event_id" IS NULL)),
	CONSTRAINT "order_fees_amounts" CHECK ("order_fees"."unit_amount_gross" >= 0 AND "order_fees"."total_gross" >= 0 AND "order_fees"."total_net" >= 0 AND "order_fees"."total_tax" >= 0
        AND "order_fees"."total_gross" = "order_fees"."total_net" + "order_fees"."total_tax")
);
--> statement-breakpoint
CREATE TABLE "order_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status",
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "order_item_kind" NOT NULL,
	"seat_id" uuid,
	"section_id" uuid NOT NULL,
	"price_category_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"status" "order_item_status" NOT NULL,
	"access_code_id" uuid,
	"section_label" text NOT NULL,
	"row_label" text,
	"seat_label" text,
	"entrance_label" text,
	"category_name" text NOT NULL,
	"ticket_type_name" text NOT NULL,
	"unit_price_gross" integer NOT NULL,
	"discount_amount" integer DEFAULT 0 NOT NULL,
	"price_gross" integer NOT NULL,
	"tax_rate_basis_points" integer NOT NULL,
	"price_net" integer NOT NULL,
	"tax_amount" integer NOT NULL,
	"attendee_name" text,
	"cancelled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_kind_seat" CHECK (("order_items"."kind" = 'SEAT') = ("order_items"."seat_id" IS NOT NULL)),
	CONSTRAINT "order_items_amounts_nonneg" CHECK ("order_items"."unit_price_gross" >= 0 AND "order_items"."discount_amount" >= 0 AND "order_items"."price_gross" >= 0
        AND "order_items"."price_net" >= 0 AND "order_items"."tax_amount" >= 0),
	CONSTRAINT "order_items_price_consistent" CHECK ("order_items"."price_gross" = "order_items"."unit_price_gross" - "order_items"."discount_amount"),
	CONSTRAINT "order_items_tax_split" CHECK ("order_items"."price_gross" = "order_items"."price_net" + "order_items"."tax_amount"),
	CONSTRAINT "order_items_tax_rate_range" CHECK ("order_items"."tax_rate_basis_points" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "order_status" NOT NULL,
	"channel" "sales_channel" NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"company" text,
	"phone" text,
	"billing_address" jsonb,
	"locale" text NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal_gross" integer NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"fee_total" integer DEFAULT 0 NOT NULL,
	"total_gross" integer NOT NULL,
	"total_net" integer NOT NULL,
	"total_tax" integer NOT NULL,
	"amount_paid" integer DEFAULT 0 NOT NULL,
	"amount_refunded" integer DEFAULT 0 NOT NULL,
	"payment_reference" text,
	"payment_due_at" timestamp with time zone,
	"next_reminder_at" timestamp with time zone,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp with time zone,
	"auto_cancel_at" timestamp with time zone,
	"keep_reserved" boolean DEFAULT false NOT NULL,
	"keep_reserved_reason" text,
	"keep_reserved_by_user_id" uuid,
	"cart_session_id" text,
	"terms_accepted_at" timestamp with time zone,
	"customer_note" text,
	"internal_note" text,
	"created_by_user_id" uuid,
	"ip_address" "inet",
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cancellation_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_uq" UNIQUE("order_number"),
	CONSTRAINT "orders_payment_reference_uq" UNIQUE("payment_reference"),
	CONSTRAINT "orders_currency_format" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_payment_reference_format" CHECK ("orders"."payment_reference" IS NULL OR "orders"."payment_reference" ~ '^[A-Z]{2,6}-[0-9]{4}-[0-9]{4,10}-[0-9]$'),
	CONSTRAINT "orders_amounts_nonneg" CHECK ("orders"."subtotal_gross" >= 0 AND "orders"."discount_total" >= 0 AND "orders"."fee_total" >= 0
        AND "orders"."total_gross" >= 0 AND "orders"."total_net" >= 0 AND "orders"."total_tax" >= 0
        AND "orders"."amount_paid" >= 0 AND "orders"."amount_refunded" >= 0),
	CONSTRAINT "orders_total_consistent" CHECK ("orders"."total_gross" = "orders"."subtotal_gross" - "orders"."discount_total" + "orders"."fee_total"),
	CONSTRAINT "orders_tax_split_consistent" CHECK ("orders"."total_gross" = "orders"."total_net" + "orders"."total_tax"),
	CONSTRAINT "orders_refund_le_paid" CHECK ("orders"."amount_refunded" <= "orders"."amount_paid"),
	CONSTRAINT "orders_paid_at" CHECK ("orders"."status" NOT IN ('PAID','REFUNDED','PARTIALLY_REFUNDED') OR "orders"."paid_at" IS NOT NULL),
	CONSTRAINT "orders_cancelled_at" CHECK ("orders"."status" <> 'CANCELLED' OR "orders"."cancelled_at" IS NOT NULL),
	CONSTRAINT "orders_expired_at" CHECK ("orders"."status" <> 'EXPIRED' OR "orders"."expired_at" IS NOT NULL),
	CONSTRAINT "orders_awaiting_has_terms" CHECK ("orders"."status" <> 'AWAITING_PAYMENT' OR ("orders"."payment_reference" IS NOT NULL AND "orders"."payment_due_at" IS NOT NULL)),
	CONSTRAINT "orders_reminder_count_nonneg" CHECK ("orders"."reminder_count" >= 0),
	CONSTRAINT "orders_version_positive" CHECK ("orders"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" NOT NULL,
	"amount" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"provider_order_id" text,
	"provider_capture_id" text,
	"bank_transaction_id" uuid,
	"received_by_user_id" uuid,
	"provider_response" jsonb,
	"failure_code" text,
	"failure_message" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_nonneg" CHECK ("payments"."amount" >= 0),
	CONSTRAINT "payments_captured_at" CHECK ("payments"."status" <> 'CAPTURED' OR "payments"."captured_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "refund_items" (
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "refund_items_pk" PRIMARY KEY("refund_id","order_item_id"),
	CONSTRAINT "refund_items_amount_nonneg" CHECK ("refund_items"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid,
	"method" "payment_method" NOT NULL,
	"status" "refund_status" DEFAULT 'PENDING' NOT NULL,
	"amount" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text,
	"provider_refund_id" text,
	"credit_note_id" uuid,
	"requested_by_user_id" uuid,
	"failure_message" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_code" text NOT NULL,
	"status" "ticket_status" DEFAULT 'VALID' NOT NULL,
	"signing_key_id" uuid NOT NULL,
	"qr_payload" text NOT NULL,
	"attendee_name" text,
	"pdf_object_key" text,
	"pkpass_object_key" text,
	"google_wallet_object_id" text,
	"check_in_state" "check_in_state" DEFAULT 'NONE' NOT NULL,
	"first_checked_in_at" timestamp with time zone,
	"first_checked_in_device_id" uuid,
	"last_scan_at" timestamp with time zone,
	"check_in_count" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"replaced_by_ticket_id" uuid,
	"sync_version" bigint DEFAULT nextval('ticket_sync_version_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_ticket_code_uq" UNIQUE("ticket_code"),
	CONSTRAINT "tickets_void_consistency" CHECK (("tickets"."status" = 'VALID') = ("tickets"."voided_at" IS NULL)),
	CONSTRAINT "tickets_check_in_consistency" CHECK ("tickets"."check_in_state" = 'NONE' OR "tickets"."first_checked_in_at" IS NOT NULL),
	CONSTRAINT "tickets_check_in_count_nonneg" CHECK ("tickets"."check_in_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"status" "webhook_event_status" DEFAULT 'RECEIVED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_external_uq" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"account_holder" text NOT NULL,
	"iban" text NOT NULL,
	"bic" text,
	"bank_code" text,
	"bank_name" text,
	"currency" char(3) NOT NULL,
	"is_default_for_bank_transfer" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_iban_uq" UNIQUE("iban"),
	CONSTRAINT "bank_accounts_iban_format" CHECK ("bank_accounts"."iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
	CONSTRAINT "bank_accounts_bic_format" CHECK ("bank_accounts"."bic" IS NULL OR "bank_accounts"."bic" ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
	CONSTRAINT "bank_accounts_bank_code_format" CHECK ("bank_accounts"."bank_code" IS NULL OR "bank_accounts"."bank_code" ~ '^[0-9]{8}$')
);
--> statement-breakpoint
CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"adapter" "bank_adapter" NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"poll_interval_seconds" integer,
	"config" jsonb NOT NULL,
	"credentials_encrypted" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_expires_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"last_sync_status" "bank_sync_status",
	"last_error" text,
	"next_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_connections_adapter_matches_config" CHECK ("bank_connections"."config" ->> 'adapter' = "bank_connections"."adapter"::text),
	CONSTRAINT "bank_connections_poll_interval" CHECK ("bank_connections"."poll_interval_seconds" IS NULL OR "bank_connections"."poll_interval_seconds" >= 60)
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"connection_id" uuid,
	"source" "bank_import_source" NOT NULL,
	"format" "bank_statement_format" NOT NULL,
	"file_name" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" "bank_import_status" DEFAULT 'PROCESSING' NOT NULL,
	"statement_id" text,
	"period_from" date,
	"period_to" date,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bank_statement_imports_file_uq" UNIQUE("bank_account_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "bank_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" "bank_sync_trigger" NOT NULL,
	"status" "bank_sync_status" DEFAULT 'RUNNING' NOT NULL,
	"period_from" date,
	"period_to" date,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"triggered_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_tan_challenges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"connection_id" uuid NOT NULL,
	"sync_run_id" uuid,
	"status" "tan_challenge_status" DEFAULT 'PENDING' NOT NULL,
	"tan_method" text,
	"challenge_text" text,
	"challenge_media_mime_type" text,
	"challenge_media_base64" text,
	"is_decoupled" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_by_user_id" uuid,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transaction_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bank_transaction_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid,
	"amount" integer NOT NULL,
	"method" "allocation_method" NOT NULL,
	"allocated_by_user_id" uuid,
	"note" text,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_tx_allocations_amount_positive" CHECK ("bank_transaction_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"import_id" uuid,
	"sync_run_id" uuid,
	"fingerprint" text NOT NULL,
	"external_id" text,
	"booking_date" date NOT NULL,
	"value_date" date,
	"amount" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"counterparty_name" text,
	"counterparty_iban" text,
	"counterparty_bic" text,
	"remittance_information" text,
	"end_to_end_id" text,
	"bank_transaction_code" text,
	"raw_data" jsonb,
	"match_status" "bank_tx_match_status" DEFAULT 'UNMATCHED' NOT NULL,
	"review_reason" "bank_tx_review_reason",
	"extracted_reference" text,
	"match_confidence" smallint,
	"match_candidates" jsonb,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_fingerprint_uq" UNIQUE("bank_account_id","fingerprint"),
	CONSTRAINT "bank_transactions_currency_format" CHECK ("bank_transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bank_transactions_review_reason" CHECK ("bank_transactions"."match_status" <> 'NEEDS_REVIEW' OR "bank_transactions"."review_reason" IS NOT NULL),
	CONSTRAINT "bank_transactions_confidence_range" CHECK ("bank_transactions"."match_confidence" IS NULL OR "bank_transactions"."match_confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"template_key" "email_template_key",
	"order_id" uuid,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"status" "email_status" DEFAULT 'QUEUED' NOT NULL,
	"attachments" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"job_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_attempts_nonneg" CHECK ("email_messages"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" "email_template_key" NOT NULL,
	"event_id" uuid,
	"locale" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_templates_key_event_locale_uq" UNIQUE NULLS NOT DISTINCT("key","event_id","locale")
);
--> statement-breakpoint
CREATE TABLE "ticket_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"page_width_mm" real NOT NULL,
	"page_height_mm" real NOT NULL,
	"background_asset_id" uuid,
	"layout" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_templates_page_size" CHECK ("ticket_templates"."page_width_mm" BETWEEN 20 AND 2000 AND "ticket_templates"."page_height_mm" BETWEEN 20 AND 2000),
	CONSTRAINT "ticket_templates_default_is_global" CHECK (NOT "ticket_templates"."is_default" OR "ticket_templates"."event_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "wallet_pass_designs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid,
	"background_color" text NOT NULL,
	"foreground_color" text NOT NULL,
	"label_color" text NOT NULL,
	"logo_text" text,
	"description" text,
	"logo_asset_id" uuid,
	"icon_asset_id" uuid,
	"strip_asset_id" uuid,
	"hero_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_pass_designs_event_uq" UNIQUE NULLS NOT DISTINCT("event_id"),
	CONSTRAINT "wallet_pass_designs_colors" CHECK ("wallet_pass_designs"."background_color" ~ '^#[0-9A-Fa-f]{6}$' AND "wallet_pass_designs"."foreground_color" ~ '^#[0-9A-Fa-f]{6}$' AND "wallet_pass_designs"."label_color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "check_in_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_id" uuid,
	"device_id" uuid,
	"client_scan_id" uuid,
	"staff_user_id" uuid,
	"entrance_id" uuid,
	"action" "scan_action" NOT NULL,
	"source" "scan_source" NOT NULL,
	"result" "scan_result" NOT NULL,
	"warnings" "scan_warning"[] DEFAULT '{}'::scan_warning[] NOT NULL,
	"raw_payload" text,
	"message" text,
	"scanned_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"was_offline" boolean DEFAULT false NOT NULL,
	CONSTRAINT "check_in_logs_client_scan_uq" UNIQUE("device_id","client_scan_id"),
	CONSTRAINT "check_in_logs_raw_payload_len" CHECK ("check_in_logs"."raw_payload" IS NULL OR char_length("check_in_logs"."raw_payload") <= 512)
);
--> statement-breakpoint
CREATE TABLE "device_pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" text NOT NULL,
	"label" text,
	"event_id" uuid,
	"entrance_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"device_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairing_codes_hash_uq" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "scanner_device_events" (
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"entrance_id" uuid,
	"allow_check_out" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scanner_device_events_pk" PRIMARY KEY("device_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "scanner_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"platform" text,
	"app_version" text,
	"device_model" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"paired_by_user_id" uuid,
	"last_seen_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_sync_version" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scanner_devices_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "scanner_devices_revoked_inactive" CHECK ("scanner_devices"."revoked_at" IS NULL OR NOT "scanner_devices"."is_active")
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_admin_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_device_id_scanner_devices_id_fk" FOREIGN KEY ("actor_device_id") REFERENCES "public"."scanner_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_user_id_admin_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_elements" ADD CONSTRAINT "seat_map_elements_seat_map_id_seat_maps_id_fk" FOREIGN KEY ("seat_map_id") REFERENCES "public"."seat_maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_elements" ADD CONSTRAINT "seat_map_elements_section_id_seat_map_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."seat_map_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_elements" ADD CONSTRAINT "seat_map_elements_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_entrances" ADD CONSTRAINT "seat_map_entrances_seat_map_id_seat_maps_id_fk" FOREIGN KEY ("seat_map_id") REFERENCES "public"."seat_maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_rows" ADD CONSTRAINT "seat_map_rows_seat_map_id_seat_maps_id_fk" FOREIGN KEY ("seat_map_id") REFERENCES "public"."seat_maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_rows" ADD CONSTRAINT "seat_map_rows_section_id_seat_map_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."seat_map_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD CONSTRAINT "seat_map_sections_seat_map_id_seat_maps_id_fk" FOREIGN KEY ("seat_map_id") REFERENCES "public"."seat_maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD CONSTRAINT "seat_map_sections_entrance_id_seat_map_entrances_id_fk" FOREIGN KEY ("entrance_id") REFERENCES "public"."seat_map_entrances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD CONSTRAINT "seat_map_sections_price_category_id_price_categories_id_fk" FOREIGN KEY ("price_category_id") REFERENCES "public"."price_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_maps" ADD CONSTRAINT "seat_maps_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_maps" ADD CONSTRAINT "seat_maps_cloned_from_id_seat_maps_id_fk" FOREIGN KEY ("cloned_from_id") REFERENCES "public"."seat_maps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_maps" ADD CONSTRAINT "seat_maps_background_asset_id_media_assets_id_fk" FOREIGN KEY ("background_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_seat_map_id_seat_maps_id_fk" FOREIGN KEY ("seat_map_id") REFERENCES "public"."seat_maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_section_id_seat_map_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."seat_map_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_row_id_seat_map_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."seat_map_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_table_element_id_seat_map_elements_id_fk" FOREIGN KEY ("table_element_id") REFERENCES "public"."seat_map_elements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_price_category_id_price_categories_id_fk" FOREIGN KEY ("price_category_id") REFERENCES "public"."price_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_blocked_by_user_id_admin_users_id_fk" FOREIGN KEY ("blocked_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_image_asset_id_media_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_code_redemptions" ADD CONSTRAINT "access_code_redemptions_access_code_id_access_codes_id_fk" FOREIGN KEY ("access_code_id") REFERENCES "public"."access_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_code_redemptions" ADD CONSTRAINT "access_code_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_codes" ADD CONSTRAINT "access_codes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_codes" ADD CONSTRAINT "access_codes_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series" ADD CONSTRAINT "event_series_image_asset_id_media_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_signing_keys" ADD CONSTRAINT "event_signing_keys_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_series_id_event_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."event_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_hero_image_asset_id_media_assets_id_fk" FOREIGN KEY ("hero_image_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_ticket_template_id_ticket_templates_id_fk" FOREIGN KEY ("ticket_template_id") REFERENCES "public"."ticket_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_cloned_from_id_events_id_fk" FOREIGN KEY ("cloned_from_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_seat_map_fk" FOREIGN KEY ("seat_map_id","seat_map_kind") REFERENCES "public"."seat_maps"("id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fees" ADD CONSTRAINT "fees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fees" ADD CONSTRAINT "fees_overrides_fee_id_fees_id_fk" FOREIGN KEY ("overrides_fee_id") REFERENCES "public"."fees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fees" ADD CONSTRAINT "fees_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_categories" ADD CONSTRAINT "price_categories_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_categories" ADD CONSTRAINT "price_categories_ticket_template_id_ticket_templates_id_fk" FOREIGN KEY ("ticket_template_id") REFERENCES "public"."ticket_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_category_ticket_types" ADD CONSTRAINT "price_category_ticket_types_price_category_id_price_categories_id_fk" FOREIGN KEY ("price_category_id") REFERENCES "public"."price_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_category_ticket_types" ADD CONSTRAINT "price_category_ticket_types_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_announcements" ADD CONSTRAINT "queue_announcements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_announcements" ADD CONSTRAINT "queue_announcements_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_configs" ADD CONSTRAINT "queue_configs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_configs" ADD CONSTRAINT "queue_configs_updated_by_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tokens" ADD CONSTRAINT "customer_tokens_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_fee_id_order_fees_id_fk" FOREIGN KEY ("order_fee_id") REFERENCES "public"."order_fees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_corrects_invoice_id_invoices_id_fk" FOREIGN KEY ("corrects_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_fee_id_fees_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."fees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_history" ADD CONSTRAINT "order_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_history" ADD CONSTRAINT "order_history_actor_user_id_admin_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_section_id_seat_map_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."seat_map_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_category_id_price_categories_id_fk" FOREIGN KEY ("price_category_id") REFERENCES "public"."price_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_access_code_id_access_codes_id_fk" FOREIGN KEY ("access_code_id") REFERENCES "public"."access_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_keep_reserved_by_user_id_admin_users_id_fk" FOREIGN KEY ("keep_reserved_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_user_id_admin_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_admin_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_signing_key_id_event_signing_keys_id_fk" FOREIGN KEY ("signing_key_id") REFERENCES "public"."event_signing_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_first_checked_in_device_id_scanner_devices_id_fk" FOREIGN KEY ("first_checked_in_device_id") REFERENCES "public"."scanner_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_replaced_by_ticket_id_tickets_id_fk" FOREIGN KEY ("replaced_by_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_uploaded_by_user_id_admin_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_sync_runs" ADD CONSTRAINT "bank_sync_runs_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_sync_runs" ADD CONSTRAINT "bank_sync_runs_triggered_by_user_id_admin_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_tan_challenges" ADD CONSTRAINT "bank_tan_challenges_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_tan_challenges" ADD CONSTRAINT "bank_tan_challenges_sync_run_id_bank_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."bank_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_tan_challenges" ADD CONSTRAINT "bank_tan_challenges_responded_by_user_id_admin_users_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_allocations" ADD CONSTRAINT "bank_transaction_allocations_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_allocations" ADD CONSTRAINT "bank_transaction_allocations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_allocations" ADD CONSTRAINT "bank_transaction_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_allocations" ADD CONSTRAINT "bank_transaction_allocations_allocated_by_user_id_admin_users_id_fk" FOREIGN KEY ("allocated_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_allocations" ADD CONSTRAINT "bank_transaction_allocations_reversed_by_user_id_admin_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_id_bank_statement_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."bank_statement_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_sync_run_id_bank_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."bank_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reviewed_by_user_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_updated_by_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_background_asset_id_media_assets_id_fk" FOREIGN KEY ("background_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_pass_designs" ADD CONSTRAINT "wallet_pass_designs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_pass_designs" ADD CONSTRAINT "wallet_pass_designs_logo_asset_id_media_assets_id_fk" FOREIGN KEY ("logo_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_pass_designs" ADD CONSTRAINT "wallet_pass_designs_icon_asset_id_media_assets_id_fk" FOREIGN KEY ("icon_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_pass_designs" ADD CONSTRAINT "wallet_pass_designs_strip_asset_id_media_assets_id_fk" FOREIGN KEY ("strip_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_pass_designs" ADD CONSTRAINT "wallet_pass_designs_hero_asset_id_media_assets_id_fk" FOREIGN KEY ("hero_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_logs" ADD CONSTRAINT "check_in_logs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_logs" ADD CONSTRAINT "check_in_logs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_logs" ADD CONSTRAINT "check_in_logs_device_id_scanner_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."scanner_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_logs" ADD CONSTRAINT "check_in_logs_staff_user_id_admin_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in_logs" ADD CONSTRAINT "check_in_logs_entrance_id_seat_map_entrances_id_fk" FOREIGN KEY ("entrance_id") REFERENCES "public"."seat_map_entrances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_entrance_id_seat_map_entrances_id_fk" FOREIGN KEY ("entrance_id") REFERENCES "public"."seat_map_entrances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_device_id_scanner_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."scanner_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_device_events" ADD CONSTRAINT "scanner_device_events_device_id_scanner_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."scanner_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_device_events" ADD CONSTRAINT "scanner_device_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_device_events" ADD CONSTRAINT "scanner_device_events_entrance_id_seat_map_entrances_id_fk" FOREIGN KEY ("entrance_id") REFERENCES "public"."seat_map_entrances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_devices" ADD CONSTRAINT "scanner_devices_paired_by_user_id_admin_users_id_fk" FOREIGN KEY ("paired_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_sessions_user_idx" ON "admin_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_uq" ON "admin_users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_assets_kind_idx" ON "media_assets" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_sha256_idx" ON "media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_single_default_uq" ON "tax_rates" USING btree ("is_default") WHERE "tax_rates"."is_default";--> statement-breakpoint
CREATE INDEX "seat_map_elements_map_idx" ON "seat_map_elements" USING btree ("seat_map_id","z_index");--> statement-breakpoint
CREATE INDEX "seat_map_rows_map_idx" ON "seat_map_rows" USING btree ("seat_map_id");--> statement-breakpoint
CREATE INDEX "seat_map_sections_map_idx" ON "seat_map_sections" USING btree ("seat_map_id","sort_order");--> statement-breakpoint
CREATE INDEX "seat_maps_venue_idx" ON "seat_maps" USING btree ("venue_id","kind");--> statement-breakpoint
CREATE INDEX "seats_map_idx" ON "seats" USING btree ("seat_map_id") WHERE "seats"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seats_section_idx" ON "seats" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "seats_category_idx" ON "seats" USING btree ("price_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_row_label_uq" ON "seats" USING btree ("row_id","label") WHERE "seats"."row_id" IS NOT NULL AND "seats"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seats_row_position_uq" ON "seats" USING btree ("row_id","position") WHERE "seats"."row_id" IS NOT NULL AND "seats"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seats_table_position_uq" ON "seats" USING btree ("table_element_id","position") WHERE "seats"."table_element_id" IS NOT NULL AND "seats"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "access_code_redemptions_code_idx" ON "access_code_redemptions" USING btree ("access_code_id");--> statement-breakpoint
CREATE INDEX "access_code_redemptions_order_idx" ON "access_code_redemptions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_signing_keys_single_active_uq" ON "event_signing_keys" USING btree ("event_id") WHERE "event_signing_keys"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "events_status_starts_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "events_series_idx" ON "events" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "events_venue_idx" ON "events" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "fees_event_idx" ON "fees" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fees_single_override_per_event_uq" ON "fees" USING btree ("event_id","overrides_fee_id") WHERE "fees"."overrides_fee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "price_categories_event_idx" ON "price_categories" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX "price_category_ticket_types_type_idx" ON "price_category_ticket_types" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "queue_announcements_event_idx" ON "queue_announcements" USING btree ("event_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_types_single_default_uq" ON "ticket_types" USING btree ("event_id") WHERE "ticket_types"."is_default";--> statement-breakpoint
CREATE INDEX "customer_sessions_customer_idx" ON "customer_sessions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_sessions_expires_idx" ON "customer_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "customer_tokens_customer_idx" ON "customer_tokens" USING btree ("customer_id","purpose");--> statement-breakpoint
CREATE INDEX "customer_tokens_expires_idx" ON "customer_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_uq" ON "customers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING gin (("first_name" || ' ' || "last_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "invoices_order_idx" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_fees_order_idx" ON "order_fees" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_history_order_idx" ON "order_history" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_active_seat_uq" ON "order_items" USING btree ("seat_id") WHERE "order_items"."seat_id" IS NOT NULL AND "order_items"."status" IN ('PENDING','CONFIRMED');--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_event_status_idx" ON "order_items" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "order_items_section_idx" ON "order_items" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "order_items_category_idx" ON "order_items" USING btree ("price_category_id");--> statement-breakpoint
CREATE INDEX "order_items_access_code_idx" ON "order_items" USING btree ("access_code_id") WHERE "order_items"."access_code_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_awaiting_due_idx" ON "orders" USING btree ("auto_cancel_at") WHERE "orders"."status" = 'AWAITING_PAYMENT';--> statement-breakpoint
CREATE INDEX "orders_awaiting_reminder_idx" ON "orders" USING btree ("next_reminder_at") WHERE "orders"."status" = 'AWAITING_PAYMENT';--> statement-breakpoint
CREATE INDEX "orders_pending_created_idx" ON "orders" USING btree ("created_at") WHERE "orders"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "orders_name_trgm_idx" ON "orders" USING gin (("first_name" || ' ' || "last_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order_uq" ON "payments" USING btree ("method","provider_order_id") WHERE "payments"."provider_order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_capture_uq" ON "payments" USING btree ("provider_capture_id") WHERE "payments"."provider_capture_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_bank_tx_idx" ON "payments" USING btree ("bank_transaction_id");--> statement-breakpoint
CREATE INDEX "refund_items_item_idx" ON "refund_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_refund_uq" ON "refunds" USING btree ("provider_refund_id") WHERE "refunds"."provider_refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_single_valid_per_item_uq" ON "tickets" USING btree ("order_item_id") WHERE "tickets"."status" = 'VALID';--> statement-breakpoint
CREATE INDEX "tickets_order_idx" ON "tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "tickets_event_sync_idx" ON "tickets" USING btree ("event_id","sync_version");--> statement-breakpoint
CREATE INDEX "tickets_attendee_trgm_idx" ON "tickets" USING gin ("attendee_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_single_default_uq" ON "bank_accounts" USING btree ("is_default_for_bank_transfer") WHERE "bank_accounts"."is_default_for_bank_transfer";--> statement-breakpoint
CREATE INDEX "bank_connections_account_idx" ON "bank_connections" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "bank_connections_next_sync_idx" ON "bank_connections" USING btree ("next_sync_at") WHERE "bank_connections"."is_active";--> statement-breakpoint
CREATE INDEX "bank_statement_imports_account_idx" ON "bank_statement_imports" USING btree ("bank_account_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_sync_runs_connection_idx" ON "bank_sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_sync_runs_single_running_uq" ON "bank_sync_runs" USING btree ("connection_id") WHERE "bank_sync_runs"."status" IN ('RUNNING','TAN_REQUIRED');--> statement-breakpoint
CREATE INDEX "bank_tan_challenges_pending_idx" ON "bank_tan_challenges" USING btree ("connection_id") WHERE "bank_tan_challenges"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "bank_tx_allocations_tx_idx" ON "bank_transaction_allocations" USING btree ("bank_transaction_id");--> statement-breakpoint
CREATE INDEX "bank_tx_allocations_order_idx" ON "bank_transaction_allocations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_status_idx" ON "bank_transactions" USING btree ("match_status","booking_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_reference_idx" ON "bank_transactions" USING btree ("extracted_reference");--> statement-breakpoint
CREATE INDEX "bank_transactions_booking_idx" ON "bank_transactions" USING btree ("bank_account_id","booking_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_counterparty_trgm_idx" ON "bank_transactions" USING gin ("counterparty_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "email_messages_order_idx" ON "email_messages" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "email_messages_status_idx" ON "email_messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ticket_templates_event_idx" ON "ticket_templates" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_templates_single_default_uq" ON "ticket_templates" USING btree ("is_default") WHERE "ticket_templates"."is_default" AND "ticket_templates"."event_id" IS NULL;--> statement-breakpoint
CREATE INDEX "check_in_logs_event_idx" ON "check_in_logs" USING btree ("event_id","scanned_at");--> statement-breakpoint
CREATE INDEX "check_in_logs_ticket_idx" ON "check_in_logs" USING btree ("ticket_id","scanned_at");--> statement-breakpoint
CREATE INDEX "device_pairing_codes_expires_idx" ON "device_pairing_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "scanner_device_events_event_idx" ON "scanner_device_events" USING btree ("event_id");