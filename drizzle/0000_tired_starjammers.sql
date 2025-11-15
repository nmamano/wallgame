CREATE TABLE "puzzles" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(100) NOT NULL,
	"author" varchar(100) NOT NULL,
	"rating" integer NOT NULL
);
