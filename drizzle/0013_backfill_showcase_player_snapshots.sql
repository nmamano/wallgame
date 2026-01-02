UPDATE "game_players" gp
SET "display_name" = u.display_name
FROM "users" u
WHERE gp.display_name IS NULL
  AND gp.user_id = u.user_id;

UPDATE "game_players" gp
SET "display_name" = b.display_name
FROM "built_in_bots" b
WHERE gp.display_name IS NULL
  AND gp.bot_id = b.bot_id;

UPDATE "game_players"
SET "display_name" = 'Guest'
WHERE display_name IS NULL;

ALTER TABLE "game_players"
ALTER COLUMN "display_name" SET NOT NULL;
