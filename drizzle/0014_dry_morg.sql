CREATE TABLE "campaign_progress" (
	"user_id" integer NOT NULL,
	"level_id" varchar(32) NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_progress_user_id_level_id_pk" PRIMARY KEY("user_id","level_id")
);
--> statement-breakpoint
ALTER TABLE "campaign_progress" ADD CONSTRAINT "campaign_progress_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
