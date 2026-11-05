/**
 * Build the VS riser - the one synthesised sting Nil kept. (The daily VS
 * banners' whoosh went with the banners: Nil, 2026-11-05, C56, "the static
 * noise at the beginning".)
 *
 * Board task f89e649f. This file once produced six candidates for the VS stamp
 * and the win. Nil rejected five of them as synthetic and chose real
 * recordings instead (Pixel Game Essentials, see the SOUNDS table in
 * render-game-video.mjs); the riser survived, with "for now" attached to it.
 * Only the survivor is built here - the rejected five are gone rather than
 * left lying around to be picked up again by mistake.
 *
 *   node scripts/game-video/make-stings.mjs
 *   node scripts/game-video/make-stings.mjs --check
 *
 * --check builds nothing: it exits 0 when every sting and every time in
 * stings.json that this script writes is there, and stings.json was
 * written by this script as it is now (its sha256, `script`), else 1. The
 * renderer and sync-render-kit.sh ask it, so the list of what must be
 * there is this file's alone (Video Reviewer 1, review 59: a stale
 * stings.json with a time missing failed every render, 2026-10-29;
 * review 64: a changed time with an old stings.json passed).
 *
 * Writes assets/stings/vs-b-riser.wav and stings.json. The output is NOT
 * committed: this script is deterministic, so the renderer rebuilds the wav on
 * demand and nothing generated has to live in the repository.
 *
 * Built from our own audio plus tones synthesised by ffmpeg. NOTHING IS
 * DOWNLOADED, so there is no licence attached to any of it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const AUDIO = join(REPO, "frontend/public/audio");
const OUT = join(REPO, "assets/stings");
/** The stings this script builds, and the times stings.json gives. */
const STINGS = ["vs-b-riser.wav"];
const TIMES = ["vsHitSeconds"];
/** This script as it is now: stings.json from another one is stale. */
const SCRIPT = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");

if (process.argv.includes("--check")) {
  const manifest = join(OUT, "stings.json");
  const times = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8"))
    : {};
  const missing = [
    ...STINGS.filter((f) => !existsSync(join(OUT, f))),
    ...TIMES.filter((k) => !Number.isFinite(times[k])).map(
      (k) => `stings.json ${k}`,
    ),
    ...(times.script === SCRIPT
      ? []
      : ["stings.json is from another make-stings.mjs"]),
  ];
  if (missing.length > 0)
    console.error(`stings out of date: ${missing.join(", ")}`);
  process.exit(missing.length > 0 ? 1 : 0);
}
mkdirSync(OUT, { recursive: true });

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
const ff = (args) =>
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

/* ----------------------------------------------------------- ingredients -- */

/**
 * A falling sine sweep - the body of an impact.
 * Instantaneous frequency f(t) = from + (to-from)*t/dur, so the phase that
 * ffmpeg's expression evaluator needs is its integral.
 */
const sweep = (from, to, dur, amp) => {
  const k = (to - from) / (2 * dur);
  return `aevalsrc='${amp}*sin(2*PI*(${from}*t+${k}*t*t))':d=${dur}:s=44100:c=stereo`;
};

/** A plain tone that decays away - the bright ping on the impact. */
const tone = (freq, dur, amp) =>
  `aevalsrc='${amp}*sin(2*PI*${freq}*t)':d=${dur}:s=44100:c=stereo`;

/** One of our own effects, re-pitched. Below 1 is deeper and slower. */
const pitched = (file, ratio) => ({
  input: join(AUDIO, file),
  filter: `asetrate=44100*${ratio},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo`,
});

/**
 * Mix a list of parts into one wav.
 *
 * A part is either a generated source (`gen`) or one of our files (`input` +
 * `filter`). Every part carries the moment it starts and how loud it is.
 */
const build = (name, totalSeconds, parts) => {
  const inputs = [];
  const chains = [];
  parts.forEach((p, i) => {
    if (p.gen) inputs.push("-f", "lavfi", "-i", p.gen);
    else inputs.push("-i", p.input);
    const pre = p.filter ? `${p.filter},` : "";
    const fade = p.fadeOut
      ? `,afade=t=out:st=${p.fadeOut.at}:d=${p.fadeOut.dur}:curve=${p.fadeOut.curve ?? "exp"}`
      : "";
    const fadeIn = p.fadeIn ? `,afade=t=in:st=0:d=${p.fadeIn}` : "";
    chains.push(
      `[${i}:a]${pre}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo` +
        `${fadeIn}${fade},volume=${p.gain},adelay=${Math.round(p.at * 1000)}:all=1[p${i}]`,
    );
  });
  const mix =
    parts.map((_, i) => `[p${i}]`).join("") +
    `amix=inputs=${parts.length}:normalize=0:dropout_transition=0,` +
    `alimiter=limit=0.95,apad,atrim=0:${totalSeconds}[out]`;
  const path = join(OUT, `${name}.wav`);
  ff([
    ...inputs,
    "-filter_complex",
    `${chains.join(";")};${mix}`,
    "-map",
    "[out]",
    path,
  ]);
  console.log("wrote", path);
};

/* ----------------------------------------------------------- the riser -- */

/*
  The stamp lands 1.6s in, which is where the VS mark punches down. Everything
  before that moment is anticipation and everything after is tail.
*/
const HIT = 1.6;

// A tone climbs for a second and a half and the slam cuts it off, so the VS
// mark lands on the cut. Nil kept this one and called it "kinda fun".
build("vs-b-riser", 3.2, [
  {
    gen: sweep(180, 1900, 1.55, 0.3),
    at: 0.05,
    gain: 0.85,
    fadeIn: 0.5,
    fadeOut: { at: 1.45, dur: 0.1, curve: "tri" },
  },
  {
    gen: sweep(110, 42, 0.85, 0.95),
    at: HIT,
    gain: 1.0,
    fadeOut: { at: 0, dur: 0.85 },
  },
  { ...pitched("wall.wav", 0.5), at: HIT, gain: 1.6 },
  {
    gen: tone(1500, 0.45, 0.5),
    at: HIT,
    gain: 0.55,
    fadeOut: { at: 0, dur: 0.45 },
  },
  {
    gen: sweep(70, 30, 1.5, 0.35),
    at: HIT + 0.05,
    gain: 0.75,
    fadeOut: { at: 0, dur: 1.5 },
  },
]);

/*
  Publish where the impact sits inside a VS sting, so the renderer can line the
  sound up with the visual punch instead of keeping its own copy of the number.
*/
const times = { vsHitSeconds: HIT };
// --check reads TIMES: a time written here and not listed there would not
// be checked.
if (Object.keys(times).join() !== TIMES.join()) {
  throw new Error(
    `TIMES lists ${TIMES.join()}, the script writes ${Object.keys(times).join()}`,
  );
}
writeFileSync(
  join(OUT, "stings.json"),
  JSON.stringify(
    {
      ...times,
      script: SCRIPT,
      builtFrom: "our own audio plus ffmpeg synthesis; nothing downloaded",
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote", join(OUT, "stings.json"));
console.log("done");
