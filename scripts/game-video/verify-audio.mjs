/**
 * Prove the chosen sounds are actually IN a rendered video, at the right time.
 *
 * Board task f89e649f. A mix that silently drops an input still encodes, still
 * plays, and still reports a healthy volume - the level meter would show the
 * move clicks and tell you nothing about whether the win sound survived. So
 * this does not measure loudness. It takes each source file, slides it along
 * the rendered track, and reports WHERE it correlates best and HOW strongly.
 *
 *   node scripts/game-video/verify-audio.mjs --video tmp/game-video/v5P09s6K.mp4 \
 *     --expect win=32.60 --expect shake=30.20 --expect vs=0.49
 *
 * A match is the sound being present at that moment. A low score, or a peak in
 * the wrong place, means it did not make it into the mix.
 *
 * Reads only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const SR = 11025; // plenty for locating an event, and fast to correlate

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
/** --expect NAME=SECONDS, repeatable. */
const expectations = argv
  .map((a, i) => (a === "--expect" ? argv[i + 1] : null))
  .filter(Boolean)
  .map((pair) => {
    const [name, at] = pair.split("=");
    return { name, at: Number(at) };
  });

/*
  A verifier with nothing to verify must NOT pass. With zero --expect this
  printed PASS and exited 0, which is the same silent-instrument failure it
  exists to catch: a caller who mistypes the flag gets a green light on an
  unexamined file.
*/
if (expectations.length === 0) {
  console.error(
    "no --expect given, so nothing was checked. Refusing to report a pass.\n" +
      "  usage: --expect vs=0.49 --expect shake=30.20 --expect win=32.60",
  );
  process.exit(2);
}
const badTimes = expectations.filter((e) => !Number.isFinite(e.at) || e.at < 0);
if (badTimes.length > 0) {
  console.error(
    `these --expect values are not usable times: ${badTimes.map((b) => `${b.name}=${b.at}`).join(", ")}`,
  );
  process.exit(2);
}

const VIDEO = resolve(arg("video", "tmp/game-video/v5P09s6K.mp4"));
if (!existsSync(VIDEO)) {
  console.error(`no such video: ${VIDEO}`);
  process.exit(2);
}
/** How far either side of the expected moment to search. */
const WINDOW = Number(arg("window", "1.0"));

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

const work = mkdtempSync(join(tmpdir(), "verify-audio-"));
let counter = 0;

/** Decode anything ffmpeg can read into mono samples at a fixed rate. */
const samples = (file, from, duration) => {
  const raw = join(work, `s${counter++}.raw`);
  execFileSync(
    FFMPEG,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...(from != null ? ["-ss", String(from)] : []),
      ...(duration != null ? ["-t", String(duration)] : []),
      "-i",
      file,
      "-ac",
      "1",
      "-ar",
      String(SR),
      "-f",
      "s16le",
      raw,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const buf = readFileSync(raw);
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
};

/**
 * Slide `needle` along `haystack` and return the best normalised correlation
 * and where it happened.
 *
 * Normalised, so a quiet-but-present sound still scores high: what is being
 * asked is "is this waveform here", not "is this loud here".
 */
const bestMatch = (haystack, needle, step) => {
  /*
    Correlate over a SUBSAMPLED set of indices, and normalise over that same
    set. The first version of this summed the dot product every 4th sample but
    divided by the energy of ALL of them, which depresses every score by a
    factor that has nothing to do with the audio - it reported 0.25 for a
    sound that was plainly there, and would have been "fixed" by lowering the
    threshold until the wrong number passed. Normalise over exactly what you
    summed.
  */
  const STRIDE = 4;
  const idx = [];
  for (let i = 0; i < needle.length; i += STRIDE) idx.push(i);
  let nEnergy = 0;
  for (const i of idx) nEnergy += needle[i] * needle[i];
  nEnergy = Math.sqrt(nEnergy);
  if (nEnergy === 0) return { score: 0, offset: 0 };

  let best = { score: -1, offset: 0 };
  for (let start = 0; start + needle.length < haystack.length; start += step) {
    let dot = 0;
    let hEnergy = 0;
    for (const i of idx) {
      const h = haystack[start + i];
      dot += h * needle[i];
      hEnergy += h * h;
    }
    hEnergy = Math.sqrt(hEnergy);
    const score = hEnergy > 0 ? Math.abs(dot) / (nEnergy * hEnergy + 1e-12) : 0;
    if (score > best.score) best = { score, offset: start };
  }
  return best;
};

/**
 * The loudness envelope, in fixed frames.
 *
 * Waveform correlation locates a RECORDING well and a swept tone badly: a
 * sine sweep decorrelates from itself with a fraction of a cycle of
 * misalignment, so the riser scored 0.03 while sitting plainly in the mix at
 * the right moment (measured 2026-08-19 - the region is digital silence until
 * it starts, then peaks at -0.2 dB exactly on the visual punch). Comparing
 * envelopes instead asks "does the level do the same shape here", which is
 * phase-blind and answers the question for tonal material.
 */
const envelope = (signal, frame) => {
  const out = new Float32Array(Math.floor(signal.length / frame));
  for (let f = 0; f < out.length; f += 1) {
    let e = 0;
    for (let i = 0; i < frame; i += 1) e += signal[f * frame + i] ** 2;
    out[f] = Math.sqrt(e / frame);
  }
  return out;
};

/** Plain normalised correlation of two equal-length series. */
const corr = (a, b) => {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let dot = 0;
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    dot += x * y;
    ea += x * x;
    eb += y * y;
  }
  return dot / (Math.sqrt(ea * eb) + 1e-12);
};

/** What each name refers to. Kept beside the renderer's own SOUNDS table. */
const SOURCES = {
  vs: join(REPO, "assets/stings/vs-b-riser.wav"),
  shake: join(REPO, "assets/audio/pixel_game_essentials/die-1.m4a"),
  win: join(REPO, "assets/audio/pixel_game_essentials/level-complete-1.m4a"),
  pawn: join(REPO, "frontend/public/audio/pawn.wav"),
  wall: join(REPO, "frontend/public/audio/wall.wav"),
};

console.log(`video: ${VIDEO}`);
let allOk = true;
for (const { name, at } of expectations) {
  const source = SOURCES[name];
  if (!source || !existsSync(source)) {
    console.log(`${name.padEnd(6)} SOURCE MISSING (${source})`);
    allOk = false;
    continue;
  }
  const needle = samples(source).slice(0, SR * 1.2);
  const from = Math.max(0, at - WINDOW);
  const hay = samples(VIDEO, from, WINDOW * 2 + 1.4);
  const { score, offset } = bestMatch(hay, needle, Math.round(SR * 0.005));
  const foundAt = from + offset / SR;
  const drift = foundAt - at;

  /*
    Two independent methods, and either one is enough. Waveform correlation is
    the sharper test and works for recordings; the envelope test is phase-blind
    and is what catches a swept tone. Thresholds are calibrated against a real
    negative control - a render made before these sounds existed scored 0.086
    and 0.068 with half a second of drift, against 0.49 and 0.35 within 20ms
    here.
  */
  const FRAME = Math.round(SR * 0.01);
  const envHay = envelope(hay.slice(Math.max(0, offset)), FRAME);
  const envNeedle = envelope(needle, FRAME);
  const envScore = corr(envHay.slice(0, envNeedle.length), envNeedle);

  /*
    Score at the EXPECTED moment, not only at the best match anywhere in the
    window. "Where does this correlate best" is a different question from "is
    it here", and they come apart: with the stings turned down under a louder
    music bed the best match drifted to a secondary lobe 0.7s away while the
    sound sat exactly where it was scheduled. Ask the question you mean.
  */
  const atOffset = Math.round((at - from) * SR);
  const hayAt = hay.slice(atOffset, atOffset + needle.length);
  const envAt = corr(envelope(hayAt, FRAME), envNeedle);
  let dotAt = 0;
  let eAt = 0;
  let eN = 0;
  for (let i = 0; i < Math.min(hayAt.length, needle.length); i += 4) {
    dotAt += hayAt[i] * needle[i];
    eAt += hayAt[i] ** 2;
    eN += needle[i] ** 2;
  }
  const waveAt = Math.abs(dotAt) / (Math.sqrt(eAt * eN) + 1e-12);

  const timingOk = Math.abs(drift) < 0.25;
  const byWave = (score > 0.35 && timingOk) || waveAt > 0.35;
  const byEnvelope = (envScore > 0.6 && timingOk) || envAt > 0.6;
  const present = byWave || byEnvelope;
  if (!present) allOk = false;
  console.log(
    `${name.padEnd(6)} expected ${at.toFixed(2)}s  found ${foundAt.toFixed(2)}s  ` +
      `drift ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}s  wave ${score.toFixed(3)}  ` +
      `env ${envScore.toFixed(3)}  |  at-expected wave ${waveAt.toFixed(3)} env ${envAt.toFixed(3)}  ` +
      `${present ? `PRESENT (${byWave ? "waveform" : "envelope"})` : "NOT FOUND AT THIS TIME"}`,
  );
}
console.log(
  allOk
    ? "\nPASS: every expected sound is in the mix at its moment."
    : "\nFAIL",
);
process.exit(allOk ? 0 : 1);
