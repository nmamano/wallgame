CREATE TABLE "campaign_level_completions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"level_id" varchar(32) NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_level_completions_user_level_unique" UNIQUE("user_id","level_id")
);
--> statement-breakpoint
ALTER TABLE "campaign_level_completions" ADD CONSTRAINT "campaign_level_completions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;