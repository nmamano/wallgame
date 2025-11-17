CREATE TABLE "ratings" (
	"user_id" integer NOT NULL,
	"variant" varchar(255) NOT NULL,
	"time_control" varchar(255) NOT NULL,
	"rating" integer DEFAULT 1200 NOT NULL,
	"peak_rating" integer DEFAULT 1200 NOT NULL,
	"record_wins" integer DEFAULT 0 NOT NULL,
	"record_losses" integer DEFAULT 0 NOT NULL,
	"last_game_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_user_id_variant_time_control_pk" PRIMARY KEY("user_id","variant","time_control")
);
--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;