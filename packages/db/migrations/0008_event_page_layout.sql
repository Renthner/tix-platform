ALTER TABLE "events" ADD COLUMN "page_layout" jsonb DEFAULT '["SHOP","DESCRIPTION","INFO_BOXES"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "info_boxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Carry over the previous "description above the plan" setting into the new page layout.
UPDATE "events" SET "page_layout" = '["DESCRIPTION","INFO_BOXES","SHOP"]'::jsonb WHERE "description_position" = 'ABOVE_PLAN';
