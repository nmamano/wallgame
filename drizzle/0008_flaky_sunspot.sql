ALTER TABLE "ratings" ALTER COLUMN "rating" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "ratings" ALTER COLUMN "rating" SET DEFAULT 1500;--> statement-breakpoint
ALTER TABLE "ratings" ALTER COLUMN "peak_rating" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "ratings" ALTER COLUMN "peak_rating" SET DEFAULT 1500;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "rating_deviation" double precision DEFAULT 350 NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "volatility" double precision DEFAULT 0.06 NOT NULL;