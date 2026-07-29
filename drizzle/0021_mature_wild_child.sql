CREATE TABLE "puzzle_votes" (
	"user_id" integer NOT NULL,
	"puzzle_id" text NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "puzzle_votes_user_id_puzzle_id_pk" PRIMARY KEY("user_id","puzzle_id"),
	CONSTRAINT "puzzle_votes_value_check" CHECK ("puzzle_votes"."value" in (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "puzzle_votes" ADD CONSTRAINT "puzzle_votes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_votes" ADD CONSTRAINT "puzzle_votes_puzzle_id_saved_puzzles_id_fk" FOREIGN KEY ("puzzle_id") REFERENCES "public"."saved_puzzles"("id") ON DELETE no action ON UPDATE no action;