/**
 * Measure a rendered mix the way it is HEARD, not the way it peaks.
 *
 * Board task f89e649f. Every level on this task was first set by peak, and
 * every one of them then needed a correction by ear - the win sting most of
 * all, three times. Peak is the right measure for an impact: a move click is
 * 0.1s long and its peak is essentially all of it. It is the wrong measure for
 * the win, which is a 2.6s sustained tonal sound carrying far more energy at
 * the same peak, and is heard far louder for it.
 *
 * So this reports both. Loudness here is EBU R128 MOMENTARY loudness (a 400ms
 * window), which is the standard measure for short events; the value quoted
 * for an event is the loudest momentary reading inside its window.
 *
 *   node scripts/game-video/measure-mix.mjs --video FILE \
 *     --event "pawn click=19.00" --event "win=35.80"
 *
 * Reads only.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const events = argv
  .map((a, i) => (a === "--event" ? argv[i + 1] : null))
  .filter(Boolean)
  .map((e) => {
    const at = e.lastIndexOf("=");
    return { label: e.slice(0, at), at: Number(e.slice(at + 1)) };
  });

/*
  A table with no rows is not a measurement. With zero --event this printed an
  empty table and announced that the two measures agree - agreeing about
  nothing. Refuse instead.
*/
if (events.length === 0) {
  console.error(
    "no --event given, so nothing was measured.\n" +
      '  usage: --event "pawn click=19.00" --event "win=35.80"',
  );
  process.exit(2);
}
const badTimes = events.filter(
  (e) => !e.label || !Number.isFinite(e.at) || e.at < 0,
);
if (badTimes.length > 0) {
  console.error(
    `these --event values are not usable: ${badTimes.map((b) => `${b.label}=${b.at}`).join(", ")}`,
  );
  process.exit(2);
}

const VIDEO = resolve(arg("video"));
if (!arg("video") || !existsSync(VIDEO)) {
  console.error(`no such video: ${arg("video") ?? "(--video not given)"}`);
  process.exit(2);
}
/** How long an event is allowed to be, for the loudness window. */
const WINDOW = Number(arg("window", "1.2"));

const FFMPEG = (() => {
  const scratch = join(
    REPO,
    "tmp/f89e649f-video/enc/node_modules/ffmpeg-static/ffmpeg",
  );
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch {
    if (existsSync(scratch)) return scratch;
    console.error("ffmpeg not found");
    process.exit(3);
  }
})();

const run = (args) =>
  execFileSync("/bin/sh", ["-c", `${JSON.stringify(FFMPEG)} ${args} 2>&1`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

/** ebur128 prints one t/M/S line per frame; collect them all once. */
const trace = run(
  `-hide_banner -nostats -i ${JSON.stringify(VIDEO)} -filter_complex ebur128 -f null -`,
)
  .split("\n")
  // t and M are not adjacent - a TARGET field sits between them - so they are
  // matched separately rather than with one pattern that assumes the order.
  .map((l) => {
    const t = /\bt:\s*([0-9.]+)/.exec(l);
    const m = /\bM:\s*(-?[0-9.]+)/.exec(l);
    return t && m ? { t: Number(t[1]), M: Number(m[1]) } : null;
  })
  .filter(Boolean);

if (trace.length === 0) {
  console.error(
    "ebur128 produced no momentary readings - refusing to report a table from nothing",
  );
  process.exit(4);
}

const peak = (at) => {
  const out = run(
    `-hide_banner -ss ${at} -t 0.35 -i ${JSON.stringify(VIDEO)} -af volumedetect -f null /dev/null`,
  );
  const m = /max_volume:\s*(-?[0-9.]+) dB/.exec(out);
  return m ? Number(m[1]) : null;
};

console.log(`${VIDEO}\n`);
console.log(
  `${"event".padEnd(16)}${"peak dB".padStart(10)}${"loudness LUFS".padStart(16)}`,
);
const rows = [];
for (const { label, at } of events) {
  const inWindow = trace.filter((r) => r.t >= at && r.t <= at + WINDOW);
  const loud = inWindow.length ? Math.max(...inWindow.map((r) => r.M)) : null;
  const pk = peak(at);
  rows.push({ label, pk, loud });
  console.log(
    label.padEnd(16) +
      (pk === null ? "n/a" : pk.toFixed(1)).padStart(10) +
      (loud === null ? "n/a" : loud.toFixed(1)).padStart(16),
  );
}

/**
 * Does loudness rank them differently from peak? That is the whole point.
 *
 * Rows with no reading are excluded rather than sorted - a null compares as
 * zero and put a SILENCE CONTROL at the top of the loudness ranking, which is
 * the kind of nonsense that discredits a table someone is about to act on.
 */
const ranked = rows.filter((r) => r.pk !== null && r.loud !== null);
if (ranked.length < 2) {
  console.error(
    `\nonly ${ranked.length} event(s) produced a reading, so there is no ordering to compare.`,
  );
  process.exit(4);
}
const byPeak = [...ranked].sort((a, b) => b.pk - a.pk).map((r) => r.label);
const byLoud = [...ranked].sort((a, b) => b.loud - a.loud).map((r) => r.label);
console.log(`\nloudest first, by peak:     ${byPeak.join(" > ")}`);
console.log(`loudest first, by loudness: ${byLoud.join(" > ")}`);
console.log(
  byPeak.join("|") === byLoud.join("|")
    ? "\nThe two measures agree on the ordering."
    : "\nTHE TWO MEASURES DISAGREE. Loudness is the one that matches how it is heard.",
);
