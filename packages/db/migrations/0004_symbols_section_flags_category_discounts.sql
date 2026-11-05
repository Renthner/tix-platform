CREATE TYPE "public"."symbol_kind" AS ENUM('SEAT', 'ELEMENT');--> statement-breakpoint
CREATE TABLE "svg_symbols" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"kind" "symbol_kind" NOT NULL,
	"view_box" text NOT NULL,
	"markup" text NOT NULL,
	"colorize" boolean DEFAULT true NOT NULL,
	"builtin_key" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "svg_symbols_markup_size" CHECK (char_length("svg_symbols"."markup") <= 50000),
	CONSTRAINT "svg_symbols_view_box" CHECK ("svg_symbols"."view_box" ~ '^-?[0-9.]+ -?[0-9.]+ [0-9.]+ [0-9.]+$')
);
--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD COLUMN "show_name_on_map" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "seat_map_sections" ADD COLUMN "show_label_on_ticket" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "seats" ADD COLUMN "symbol_id" uuid;--> statement-breakpoint
ALTER TABLE "price_category_ticket_types" ADD COLUMN "discount_kind" "discount_kind";--> statement-breakpoint
ALTER TABLE "price_category_ticket_types" ADD COLUMN "discount_value" integer;--> statement-breakpoint
ALTER TABLE "svg_symbols" ADD CONSTRAINT "svg_symbols_created_by_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "svg_symbols_builtin_key_uq" ON "svg_symbols" USING btree ("builtin_key") WHERE "svg_symbols"."builtin_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "svg_symbols_kind_idx" ON "svg_symbols" USING btree ("kind","name");--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_symbol_id_svg_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."svg_symbols"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_category_ticket_types" ADD CONSTRAINT "price_category_ticket_types_discount_pair" CHECK (("price_category_ticket_types"."discount_kind" IS NULL) = ("price_category_ticket_types"."discount_value" IS NULL));--> statement-breakpoint
ALTER TABLE "price_category_ticket_types" ADD CONSTRAINT "price_category_ticket_types_single_override" CHECK ("price_category_ticket_types"."price_override" IS NULL OR "price_category_ticket_types"."discount_kind" IS NULL);--> statement-breakpoint
ALTER TABLE "price_category_ticket_types" ADD CONSTRAINT "price_category_ticket_types_discount_range" CHECK ("price_category_ticket_types"."discount_value" IS NULL OR ("price_category_ticket_types"."discount_value" >= 0 AND ("price_category_ticket_types"."discount_kind" <> 'PERCENT' OR "price_category_ticket_types"."discount_value" <= 10000)));