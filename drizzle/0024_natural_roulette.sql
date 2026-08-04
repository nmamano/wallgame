ALTER TABLE "saved_puzzles" ALTER COLUMN "source" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_puzzles" ALTER COLUMN "source_fingerprint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_puzzles" ADD COLUMN "author" text DEFAULT 'synthetic' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_puzzles" ADD COLUMN "difficulty" integer;--> statement-breakpoint
ALTER TABLE "saved_puzzles" ADD COLUMN "legacy_scripted_id" text;--> statement-breakpoint
ALTER TABLE "saved_puzzles" ADD CONSTRAINT "saved_puzzles_legacy_scripted_id_unique" UNIQUE("legacy_scripted_id");--> statement-breakpoint
ALTER TABLE "saved_puzzles" ADD CONSTRAINT "saved_puzzles_provenance_paired" CHECK (("saved_puzzles"."source" IS NULL) = ("saved_puzzles"."source_fingerprint" IS NULL));--> statement-breakpoint
ALTER TABLE "saved_puzzles" ADD CONSTRAINT "saved_puzzles_difficulty_tier" CHECK ("saved_puzzles"."difficulty" IS NULL OR ("saved_puzzles"."difficulty" BETWEEN 1 AND 5));