CREATE TABLE "user_auth" (
	"user_id" integer NOT NULL,
	"auth_provider" varchar(255) NOT NULL,
	"auth_user_id" text NOT NULL,
	CONSTRAINT "user_auth_user_id_auth_provider_pk" PRIMARY KEY("user_id","auth_provider"),
	CONSTRAINT "user_auth_auth_user_id_unique" UNIQUE("auth_user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_user_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"display_name" varchar(255) NOT NULL,
	"capitalized_display_name" varchar(255) NOT NULL,
	"auth_provider" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_display_name_unique" UNIQUE("display_name"),
	CONSTRAINT "lowercase_display_name" CHECK ("users"."display_name" = LOWER("users"."display_name"))
);
--> statement-breakpoint
ALTER TABLE "user_auth" ADD CONSTRAINT "user_auth_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;