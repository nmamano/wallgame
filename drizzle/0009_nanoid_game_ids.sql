DROP TABLE IF EXISTS "game_details";
DROP TABLE IF EXISTS "game_players";
DROP TABLE IF EXISTS "games";
--> statement-breakpoint
CREATE TABLE "games" (
	"game_id" varchar(255) PRIMARY KEY NOT NULL,
	"variant" varchar(255) NOT NULL,
	"time_control" varchar(255) NOT NULL,
	"rated" boolean NOT NULL,
	"match_type" varchar(255) NOT NULL,
	"board_width" integer NOT NULL,
	"board_height" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"moves_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_details" (
	"game_id" varchar(255) PRIMARY KEY NOT NULL,
	"config_parameters" jsonb,
	"moves" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_players" (
	"game_id" varchar(255) NOT NULL,
	"player_order" integer NOT NULL,
	"player_role" varchar(255) NOT NULL,
	"player_config_type" varchar(255) NOT NULL,
	"user_id" integer,
	"bot_id" varchar(255),
	"rating_at_start" integer,
	"outcome_rank" integer NOT NULL,
	"outcome_reason" varchar(255) NOT NULL,
	CONSTRAINT "game_players_game_id_player_order_pk" PRIMARY KEY("game_id","player_order")
);
--> statement-breakpoint
ALTER TABLE "game_details" ADD CONSTRAINT "game_details_game_id_games_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("game_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_game_id_games_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("game_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_bot_id_built_in_bots_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."built_in_bots"("bot_id") ON DELETE no action ON UPDATE no action;
