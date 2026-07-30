CREATE TABLE "global_ratings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"rating" double precision DEFAULT 1500 NOT NULL,
	"rating_deviation" double precision DEFAULT 350 NOT NULL,
	"volatility" double precision DEFAULT 0.06 NOT NULL,
	"peak_rating" double precision DEFAULT 1500 NOT NULL,
	"record_wins" double precision DEFAULT 0 NOT NULL,
	"record_losses" double precision DEFAULT 0 NOT NULL,
	"last_game_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating_events" (
	"game_id" varchar(255) PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "global_ratings" ADD CONSTRAINT "global_ratings_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;