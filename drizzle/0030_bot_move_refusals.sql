CREATE TABLE "bot_move_refusals" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" varchar(255) NOT NULL,
	"bot_composite_id" text NOT NULL,
	"ply" integer NOT NULL,
	"wire_move" text NOT NULL,
	"reason" text NOT NULL,
	"refused_at" timestamp with time zone DEFAULT now() NOT NULL
);
