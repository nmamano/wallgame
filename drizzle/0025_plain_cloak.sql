ALTER TABLE "games" ADD COLUMN "series_id" varchar(255);--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "rematch_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "games_series_position_unique" ON "games" USING btree ("series_id","rematch_number");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_match_tracking_paired" CHECK (("games"."series_id" IS NULL) = ("games"."rematch_number" IS NULL));--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_rematch_number_non_negative" CHECK ("games"."rematch_number" IS NULL OR "games"."rematch_number" >= 0);