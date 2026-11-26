/**
 * The renderer's command line: its usage, its flags, and the refusals that
 * stop a run before anything loads (render-game-video.mjs runs
 * `cliRefusal` first). A module of its own, with no imports, so that its
 * tests call it directly: a start of the renderer loads all its imports
 * first (1.1-1.7 s on auntie-2 under load, 2026-11-26), and a test that
 * started it 3 times ran over bun's 5 s limit (task 3ef11782).
 */

/**
 * The first line is a contract: ship.mjs (step "help") and the release
 * runbook check that `--help` prints a line that starts with it.
 */
export const USAGE =
  "usage: render-game-video.mjs --game <wallgame.io game url or id>\n" +
  "       [--seconds-per-move S] [--aspect fit|square|9x16]\n" +
  "   or: render-game-video.mjs --edl FILE   (the daily look; see edl.mjs)\n" +
  "       [--music deja-vus|tea-for-two|a-legend|skippy] [--no-music]\n" +
  "       [--sounds vsMeme=shotgun-2,finish=shotgun-4] [--board-theme crisp|default] [--out FILE]\n" +
  "  plumbing, for the app rather than for a person:\n" +
  "       [--log FILE] [--work DIR] [--ffmpeg PATH]\n" +
  "       [--browser chromium|chrome] [--encoder x264|nvenc] [--workers N]\n" +
  "       [--from-cache] [--cache DIR] [--plies FROM..TO] [--lint [--capture]] [--draft]";

/**
 * Every flag the renderer takes: "value" (--name VALUE) or "switch". The
 * renderer's readers (cliArg, arg, flag) ask for these names only, and any
 * other word on the command line stops the render before the browser
 * starts. Without it a kit older than a flag ignores the flag: a kit
 * without --from-cache captured the game live, which counts a real view
 * (Video Reviewer 1, 2026-10-27).
 */
export const FLAGS = {
  help: "switch",
  aspect: "value",
  "board-theme": "value",
  browser: "value",
  cache: "value",
  capture: "switch",
  draft: "switch",
  edl: "value",
  encoder: "value",
  ffmpeg: "value",
  "from-cache": "switch",
  game: "value",
  lint: "switch",
  log: "value",
  music: "value",
  "no-music": "switch",
  out: "value",
  plies: "value",
  "seconds-per-move": "value",
  sounds: "value",
  style: "value",
  work: "value",
  workers: "value",
};

/**
 * What stops a command line before the renderer does any work, in the
 * order the renderer checks it: `{ code: 2, stderr }` for a refusal,
 * `{ code: 0, stdout }` for --help, null to go on.
 */
export const cliRefusal = (argv) => {
  const problems = [];
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : null;
    if (name === null || !Object.hasOwn(FLAGS, name)) {
      problems.push(`${argv[i]} is not a flag of this renderer`);
    } else if (FLAGS[name] === "value") {
      if (i + 1 === argv.length || argv[i + 1].startsWith("--")) {
        problems.push(`--${name} needs a value`);
      } else {
        i += 1;
      }
    }
  }
  if (problems.length > 0) {
    return {
      code: 2,
      stderr: `${problems.join("\n")}\nKnown: ${Object.keys(FLAGS)
        .map((f) => `--${f}`)
        .join(" ")}`,
    };
  }
  const flag = (name) => argv.includes(`--${name}`);
  // --capture: the daily app's capture-only job (crew.mjs lint --capture,
  // Wall Game PM, 2026-11-17) captures the game live (one view), saves the
  // capture and lints from it. Only that.
  if (
    flag("capture") &&
    (!flag("lint") || flag("from-cache") || !flag("edl"))
  ) {
    return {
      code: 2,
      stderr:
        "--capture captures live for a lint: give --lint and --edl, not --from-cache",
    };
  }
  // A lint reads the capture, so it never costs a view (Video Editor (daily
  // app), 2026-10-29).
  if (flag("lint") && !flag("from-cache") && !flag("capture")) {
    return {
      code: 2,
      stderr:
        "--lint reads the capture cache: add --from-cache (or --capture to capture live first: one view)",
    };
  }
  if (flag("help")) return { code: 0, stdout: USAGE };
  return null;
};
