CREATE TABLE "scripted_puzzle_completions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"puzzle_id" varchar(32) NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scripted_puzzle_completions_user_puzzle_unique" UNIQUE("user_id","puzzle_id")
);
--> statement-breakpoint
ALTER TABLE "scripted_puzzle_completions" ADD CONSTRAINT "scripted_puzzle_completions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_players_user_outcome_idx" ON "game_players" USING btree ("user_id","outcome_rank","game_id");