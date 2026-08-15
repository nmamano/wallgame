/**
 * Moves the ten authored puzzles into `saved_puzzles`, so every puzzle on the
 * site is one kind of thing.
 *
 * Runs INSIDE the deployed machine, which is where DATABASE_URL lives, and is
 * a deliberate manual step rather than part of release_command:
 *
 *   fly ssh console -a wallgame -C "bun scripts/migrate-handcrafted-puzzles.ts curated-first"
 *
 * Everything happens in ONE transaction: the rows, the renumbering they force,
 * and the completions that have to follow them. Re-running is safe — the
 * authored rows are matched by `legacy_scripted_id`, which is UNIQUE.
 *
 * This file is deliberately thin. The arithmetic lives in
 * shared/domain/handcrafted-puzzle-migration.ts (unit tested, no database) and
 * the database work in server/db/apply-handcrafted-migration.ts (rehearsed
 * against production-shaped data in tests/integration). A one-shot migration
 * that only exists inside a script is a one-shot migration nobody can test.
 *
 * THE NUMBERING IS AN ARGUMENT, not a default, because it decides which live
 * links change meaning. Nil chose `curated-first` on 2026-08-04.
 */

import { nanoid } from "nanoid";

import { db } from "../server/db";
import { applyHandcraftedMigration } from "../server/db/apply-handcrafted-migration";
import type { MigrationMode } from "../shared/domain/handcrafted-puzzle-migration";

const main = async () => {
  const mode = process.argv[2] as MigrationMode | undefined;
  if (mode !== "curated-first" && mode !== "curated-last") {
    console.error(
      "usage: bun scripts/migrate-handcrafted-puzzles.ts <curated-first|curated-last>",
    );
    process.exit(1);
  }

  const result = await db.transaction((tx) =>
    applyHandcraftedMigration(tx, mode, () => nanoid(10)),
  );

  if (!result.applied) {
    console.log("authored puzzles are already migrated; nothing to do");
    process.exit(0);
  }

  console.log(
    [
      `mode: ${mode}`,
      `renumbered ${result.renumbered} existing rows`,
      `inserted ${result.inserted} authored puzzles as ${result.insertedNames[0]} .. ${result.insertedNames[result.insertedNames.length - 1]}`,
      `rewrote ${result.movedCompletions} completions onto row ids`,
      "inserted rows are ENABLED and play their authored line; the opponent only changes when a bot declares classic",
    ].join("\n"),
  );
  process.exit(0);
};

await main();
