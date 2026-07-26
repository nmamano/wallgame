CREATE TABLE "saved_puzzles" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"sort_index" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"source_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_puzzles_sort_index_unique" UNIQUE("sort_index"),
	CONSTRAINT "saved_puzzles_source_fingerprint_unique" UNIQUE("source_fingerprint")
);
