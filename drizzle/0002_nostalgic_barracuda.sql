CREATE TABLE "user_pawn_settings" (
	"user_id" integer NOT NULL,
	"pawn_type" varchar(255) NOT NULL,
	"pawn_shape" varchar(255) NOT NULL,
	CONSTRAINT "user_pawn_settings_user_id_pawn_type_pk" PRIMARY KEY("user_id","pawn_type")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"dark_theme" boolean DEFAULT true NOT NULL,
	"board_theme" varchar(255) DEFAULT 'default' NOT NULL,
	"pawn_color" varchar(255) DEFAULT 'default' NOT NULL,
	"default_variant" varchar(255) DEFAULT 'standard' NOT NULL,
	"default_time_control" varchar(255) DEFAULT 'rapid' NOT NULL,
	"default_rated_status" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_variant_settings" (
	"user_id" integer NOT NULL,
	"variant" varchar(255) NOT NULL,
	"default_parameters" jsonb NOT NULL,
	CONSTRAINT "user_variant_settings_user_id_variant_pk" PRIMARY KEY("user_id","variant")
);
--> statement-breakpoint
ALTER TABLE "user_pawn_settings" ADD CONSTRAINT "user_pawn_settings_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_variant_settings" ADD CONSTRAINT "user_variant_settings_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;