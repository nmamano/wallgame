/**
 * A numbered listening reel of meme sounds, for Nil to keep or drop by ear
 * ("reply with the numbers you like"), and the levels of new clips.
 *
 *   bun scripts/game-video/make-sound-reel.mjs --out <reel.mp4> <key>...
 *   bun scripts/game-video/make-sound-reel.mjs --measure <key>...
 *     [--ffmpeg <path>]  an ffmpeg with drawtext (the cards' text needs
 *                        it; a static build may not have it)
 *
 * The reel is one 1080x1920 card per key, in the order given: its number,
 * its family and the moment the family is for (MEME_FAMILIES), the key, and
 * its source note (MEME_SOURCE_NOTES) if it has one. Each sound plays at the
 * gain a video gives it (memeGain), so the reel compares the sounds as a
 * video plays them, not as they were uploaded. The numbers and keys are
 * also written next to the reel (<reel>.txt) and printed.
 *
 * --measure prints a MEME_SOUNDS line for each key's file in
 * assets/meme-sounds: its loudest 400 ms (EBU R128 momentary max) and its
 * true peak, measured with 400 ms of silence after the clip, so a clip
 * shorter than the window is measured whole (meme-sounds.mjs).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  MEME_FAMILIES,
  MEME_SOUNDS,
  MEME_SOURCE_NOTES,
  memeFamily,
  memeGain,
} from "./meme-sounds.mjs";
import { REPO } from "./render-kit.mjs";

const MEME_DIR = join(REPO, "assets/meme-sounds");
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
/** The silence before each sound, and the least a card lasts. */
const LEAD_SECONDS = 0.5;
const MIN_CARD_SECONDS = 2.5;

let FFMPEG = "ffmpeg";
const ffmpeg = (args) => {
  const run = spawnSync(FFMPEG, ["-nostdin", "-hide_banner", ...args], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (run.status !== 0) {
    throw new Error(`ffmpeg failed: ${run.stderr.slice(-600)}`);
  }
  return run.stderr;
};

/**
 * A clip's loudest 400 ms and true peak, from ffmpeg's ebur128 log.
 * @param {string} file
 */
export const measureClip = (file) => {
  const log = ffmpeg([
    "-i",
    file,
    "-af",
    "apad=pad_dur=0.4,ebur128=peak=true",
    "-f",
    "null",
    "-",
  ]);
  const momentary = [...log.matchAll(/ M:\s*(-?[\d.]+|-inf)/g)]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
  const peak = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(log);
  if (momentary.length === 0 || !peak) {
    throw new Error(`${file}: ebur128 gave no reading`);
  }
  return {
    lufs: Math.round(Math.max(...momentary) * 10) / 10,
    truePeak: Math.round(Number(peak[1]) * 10) / 10,
  };
};

/**
 * About how many characters a line of `size` px holds in the 1080 px card:
 * DejaVu Sans Bold's lowercase letters are about 0.6 em wide. A guess, so
 * every card is checked after it is made (edgeIsClear).
 */
const lineChars = (size) => Math.floor(1000 / (size * 0.68));

/** `text` in lines of at most `chars`, broken between words. */
export const wrapLine = (text, chars) =>
  text.split(" ").reduce(
    (lines, word) => {
      const last = lines.at(-1);
      if (last === "") lines[lines.length - 1] = word;
      else if (`${last} ${word}`.length <= chars) {
        lines[lines.length - 1] = `${last} ${word}`;
      } else lines.push(word);
      return lines;
    },
    [""],
  );

/**
 * One card's lines, top to bottom: [text, size, colour, y]. Each block
 * starts at its own y and wraps down from it; the blocks have room for two
 * lines each.
 */
export const cardLines = (n, key) =>
  [
    [String(n), 260, "white", 520],
    [memeFamily(key).toUpperCase(), 76, "0xfacc15", 840],
    [MEME_FAMILIES[memeFamily(key)], 40, "0xcbd5e1", 950],
    [key, 36, "0x94a3b8", 1070],
    ...(MEME_SOURCE_NOTES[key]
      ? [[MEME_SOURCE_NOTES[key], 34, "0xfb923c", 1150]]
      : []),
    ["reply with the numbers you like", 34, "0x64748b", 1600],
  ].flatMap(([text, size, colour, y]) =>
    wrapLine(text, lineChars(size)).map((line, i) => [
      line,
      size,
      colour,
      y + i * Math.round(size * 1.3),
    ]),
  );

/**
 * Whether a card's left and right 30 px hold only the background: a line
 * that ran off the card would show there. Read off the card's first frame.
 */
const edgeIsClear = (part) =>
  ["0", "iw-30"].every((x) => {
    const log = ffmpeg([
      "-i",
      part,
      "-vf",
      `crop=30:ih:${x}:0,signalstats,metadata=print:key=lavfi.signalstats.YMAX`,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ]);
    const ymax = Number(/YMAX=(\d+)/.exec(log)?.[1] ?? NaN);
    // The background is Y 20 or so; text is far brighter.
    return ymax < 60;
  });

const makeReel = (keys, out) => {
  const work = mkdtempSync(join(tmpdir(), "sound-reel-"));
  try {
    const parts = keys.map((key, i) => {
      const file = join(MEME_DIR, `${key}.mp3`);
      const length = Number(
        spawnSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            file,
          ],
          { encoding: "utf8" },
        ).stdout,
      );
      if (!(length > 0)) throw new Error(`${file}: no audio`);
      const seconds = Math.max(MIN_CARD_SECONDS, LEAD_SECONDS + length + 1);
      // Each line from its own file: drawtext needs no escaping then.
      const draws = cardLines(i + 1, key).map(([text, size, colour, y], j) => {
        const textFile = join(work, `${i}-${j}.txt`);
        writeFileSync(textFile, text);
        return `drawtext=fontfile=${FONT}:textfile=${textFile}:fontsize=${size}:fontcolor=${colour}:x=(w-text_w)/2:y=${y}`;
      });
      const part = join(work, `${String(i).padStart(3, "0")}.mp4`);
      ffmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x0b1220:s=1080x1920:r=30:d=${seconds}`,
        "-i",
        file,
        "-filter_complex",
        `[0:v]${draws.join(",")}[v];` +
          `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
          `adelay=${LEAD_SECONDS * 1000}:all=1,volume=${memeGain(key)},` +
          `apad,atrim=0:${seconds}[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        String(seconds),
        part,
      ]);
      if (!edgeIsClear(part)) {
        throw new Error(
          `card ${i + 1} (${key}): a line runs off the card; shorten its text`,
        );
      }
      return { part, seconds };
    });
    // One encode through the concat filter: joined parts keep no gap.
    ffmpeg([
      "-y",
      ...parts.flatMap((p) => ["-i", p.part]),
      "-filter_complex",
      parts.map((_, i) => `[${i}:v][${i}:a]`).join("") +
        `concat=n=${parts.length}:v=1:a=1[v][a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      out,
    ]);
    const total = parts.reduce((s, p) => s + p.seconds, 0);
    const list = keys.map((k, i) => `${i + 1} ${k}`).join("\n") + "\n";
    writeFileSync(`${out}.txt`, list);
    process.stdout.write(list);
    console.log(`${out}: ${keys.length} sounds, ${total.toFixed(1)} s`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const main = () => {
  const { values, positionals: keys } = parseArgs({
    options: {
      out: { type: "string" },
      measure: { type: "boolean", default: false },
      ffmpeg: { type: "string", default: "ffmpeg" },
    },
    allowPositionals: true,
    strict: true,
  });
  FFMPEG = values.ffmpeg;
  if (keys.length === 0) {
    console.error("give the keys of the sounds");
    process.exit(2);
  }
  if (values.measure) {
    for (const key of keys) {
      const m = measureClip(join(MEME_DIR, `${key}.mp3`));
      console.log(
        `  "${key}": { lufs: ${m.lufs.toFixed(1)}, truePeak: ${m.truePeak.toFixed(1)} },`,
      );
    }
    return;
  }
  const unknown = keys.filter((k) => !Object.hasOwn(MEME_SOUNDS, k));
  if (unknown.length > 0) {
    console.error(
      `not in MEME_SOUNDS (measure them and add them first): ${unknown.join(" ")}`,
    );
    process.exit(2);
  }
  if (!values.out) {
    console.error("give --out <reel.mp4>");
    process.exit(2);
  }
  const filters = spawnSync(FFMPEG, ["-hide_banner", "-filters"], {
    encoding: "utf8",
  }).stdout;
  if (!/\bdrawtext\b/.test(filters ?? "")) {
    console.error(
      `${FFMPEG} has no drawtext filter; give --ffmpeg with one that has (e.g. /usr/bin/ffmpeg)`,
    );
    process.exit(2);
  }
  makeReel(keys, values.out);
};

if (import.meta.main) main();
