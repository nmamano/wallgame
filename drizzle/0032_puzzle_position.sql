ALTER TABLE "games" ADD COLUMN "puzzle_game_id" varchar(255);--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "puzzle_ply" integer;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_puzzle_game_id_games_game_id_fk" FOREIGN KEY ("puzzle_game_id") REFERENCES "public"."games"("game_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_puzzle_position_paired" CHECK (("games"."puzzle_game_id" IS NULL) = ("games"."puzzle_ply" IS NULL));--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_puzzle_ply_non_negative" CHECK ("games"."puzzle_ply" IS NULL OR "games"."puzzle_ply" >= 0);--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_one_puzzle_source" CHECK ("games"."puzzle_id" IS NULL OR "games"."puzzle_game_id" IS NULL);