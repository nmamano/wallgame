import { basename } from "node:path";

/** The oldest Node that runs the game-video scripts (see README.md here). */
export const NODE_FLOOR = "22.18.0";

/**
 * `import.meta.main` for a script's entry check, `if (isMain(import.meta))`.
 *
 * Node added `import.meta.main` in 22.18 and 24.2. An older Node leaves it
 * undefined, so a plain `if (import.meta.main)` skips the script's whole body
 * and it exits 0 with no output. This stops it with the reason instead. The
 * check runs in every module that calls it, imported or not, so the message
 * names the script that was run (argv[1]), not the module.
 */
export function isMain(meta) {
  if (meta.main === undefined) {
    console.error(
      `${basename(process.argv[1] ?? "this script")} needs Node ${NODE_FLOOR} or later (for import.meta.main); this is Node ${process.version}.`,
    );
    process.exit(1);
  }
  return meta.main;
}
