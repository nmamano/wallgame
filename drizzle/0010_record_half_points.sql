ALTER TABLE "ratings" ALTER COLUMN "record_wins" SET DATA TYPE double precision USING "record_wins"::double precision;--> statement-breakpoint
ALTER TABLE "ratings" ALTER COLUMN "record_wins" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "ratings" ALTER COLUMN "record_losses" SET DATA TYPE double precision USING "record_losses"::double precision;--> statement-breakpoint
ALTER TABLE "ratings" ALTER COLUMN "record_losses" SET DEFAULT 0;
