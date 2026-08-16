ALTER TABLE "users" ADD COLUMN "has_chosen_display_name" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: every account that exists when this runs counts as having chosen,
-- so no current player is interrupted by the sign-up name picker. New rows take
-- the column default of false and are asked once.
--
-- Deliberately NOT narrowed to accounts still carrying a generated name. Sending
-- those players through the picker too would change what existing users see,
-- which is a product decision, not a migration detail. It stays a one-line
-- follow-up if that is ever wanted.
UPDATE "users" SET "has_chosen_display_name" = true;