/**
 * Make a "sequence" overlay's frames (overlay-clips.mjs) from a clip:
 * a green-screen (or blue-screen) video keyed to alpha, or a video that has
 * alpha already (a VP9 WebM, a ProRes 4444 MOV).
 *
 *   bun scripts/game-video/prepare-overlay-clip.mjs --in <video> --dir <name>
 *     [--key auto|green|blue|none|0xRRGGBB]
 *                              the screen colour to key out. auto (the
 *                              default) measures it on the first kept
 *                              frame's border: the meme pack's screens are
 *                              not one green (Confetti's is dark, Stupid
 *                              Stamp's is lime; 2026-10-31)
 *     [--crop W:H:X:Y]         cut the video's frame to this box first (a
 *                              letterboxed clip: its black bars are not the
 *                              screen, and auto measures the border)
 *     [--from <s>] [--to <s>]  the part of the video to keep (its own time)
 *     [--speed <x>]            play it x times as fast (sound too)
 *     [--audio own|none]       keep its sound as audio.wav (default own when
 *                              it has one)
 *     [--trim]                 crop the frames to the box of all their visible
 *                              pixels, so a corner clip's box is its art (not
 *                              for a clip that covers the board)
 *     [--spill-max <0..1>]     the most of its visible pixels that may stay
 *                              green after the key (default 0.01)
 *     [--fps <n>]              frames a second (default 30, the video's)
 *     [--height <px>]          the frames' height (default 540)
 *     [--similarity <0..1>]    how far from the key colour still keys out
 *     [--blend <0..1>]         the soft edge around it
 *     [--replace]              write over an existing clip of that name
 *
 * It writes assets/overlays/<name>/NNNN.png, audio.wav (its sound, levelled
 * by nobody: the manifest records its loudest 400 ms and true peak, and the
 * renderer brings it to the meme sounds' level as it does theirs) and
 * manifest.json, and prints
 * the `sequence` and `seconds` to put in the asset's OVERLAYS entry. The
 * entry pins the manifest's sha256: prepare a clip again (another cut,
 * other key settings) and the registry must be changed with it, so Nil
 * rates what renders.
 *
 * Look at the frames before you register a clip: the key leaves a fringe
 * when the screen is uneven, and --similarity and --blend fix most of it.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO } from "./render-kit.mjs";
import { measureClip } from "./make-sound-reel.mjs";
import {
  CLIP_AUDIO_FILE,
  OVERLAY_CLIP_DIR,
  clipFrameFile,
  clipManifestText,
  sha256,
} from "./overlay-clips.mjs";

const KEYS = {
  green: "0x00FF00",
  blue: "0x0000FF",
};

/** A sound whose loudest 400 ms is under this is silence (LUFS). */
export const SILENT_LUFS = -70;

/** A pixel that stays this much greener than its red and blue is spill. */
export const SPILL_MARGIN = 40;
/** A pixel this opaque (of 255) or more is visible, for the spill share. */
export const VISIBLE_ALPHA = 26;

/**
 * The screen's colour, as 0xRRGGBB: the median of each channel over the
 * border pixels of one frame (`rgb`, `width` x `height`, 3 bytes a pixel).
 * The border is where a green screen shows whole; the middle holds the art.
 * @param {Uint8Array} rgb
 * @param {number} width
 * @param {number} height
 */
export const borderColor = (rgb, width, height) => {
  const channels = [[], [], []];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x > 0 && y > 0 && x < width - 1 && y < height - 1) continue;
      const i = 3 * (y * width + x);
      for (let c = 0; c < 3; c += 1) channels[c].push(rgb[i + c]);
    }
  }
  const median = (v) => v.sort((a, b) => a - b)[v.length >> 1];
  return (
    "0x" +
    channels
      .map((v) => median(v).toString(16).padStart(2, "0").toUpperCase())
      .join("")
  );
};

/** How many frames the auto key looks at. */
export const KEY_SAMPLES = 8;

/** How much a screen's own channel must lead the other two (of 255): the
 * Pixabay curtain's yellow-green leads by 59 (2026-10-31). */
export const SCREEN_LEAD = 40;

/**
 * The most screen-like of some border colours (0xRRGGBB): the one whose
 * green, or blue, leads its other two channels most. Null when none leads
 * by SCREEN_LEAD: no frame shows a screen at its border.
 * @param {string[]} colours
 */
export const screenColor = (colours) => {
  const lead = (hex) => {
    const [r, g, b] = [2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(g - Math.max(r, b), b - Math.max(r, g));
  };
  const best = [...colours].sort((x, y) => lead(y) - lead(x))[0];
  return best !== undefined && lead(best) >= SCREEN_LEAD ? best : null;
};

/**
 * The box of the pixels visible (alpha VISIBLE_ALPHA or more) in any of
 * the frames (`rgba`, `count` frames of `width` x `height`), widened to
 * even sides for the encoders; null when none is.
 * @param {Uint8Array} rgba
 * @param {number} count
 * @param {number} width
 * @param {number} height
 */
export const visibleBox = (rgba, count, width, height) => {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let f = 0; f < count; f += 1) {
    const base = f * width * height * 4;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (rgba[base + 4 * (y * width + x) + 3] < VISIBLE_ALPHA) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const even = (lo, hi, max) => {
    let w = hi - lo + 1;
    if (w % 2 === 1) {
      if (hi + 1 < max) hi += 1;
      else lo -= 1;
      w += 1;
    }
    return [lo, w];
  };
  const [x, w] = even(x0, x1, width);
  const [y, h] = even(y0, y1, height);
  return { x, y, w, h };
};

/**
 * The despill type for a key colour: the channel the screen is made of.
 * @param {string} hex 0xRRGGBB
 */
export const despillOf = (hex) => {
  const [r, g, b] = [2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return b > g && b > r ? "blue" : "green";
};

/**
 * The share of a frame's visible pixels (alpha VISIBLE_ALPHA or more) that
 * stay green after the key: a fringe or a tint the key left, which would
 * show as a green rim over our pawns (Wall Game PM, 2026-10-31: "no green
 * spill"). `rgba` is 4 bytes a pixel. 0 for a frame with nothing visible.
 * @param {Uint8Array} rgba
 */
export const spillShare = (rgba) => {
  let visible = 0;
  let spill = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < VISIBLE_ALPHA) continue;
    visible += 1;
    const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]];
    if (g >= Math.max(r, b) + SPILL_MARGIN) spill += 1;
  }
  return visible === 0 ? 0 : spill / visible;
};

/**
 * A PNG's size and whether it has alpha, from its IHDR chunk (colour type 6
 * is RGBA; 4 is grey with alpha).
 * @param {Uint8Array} bytes
 */
export const pngInfo = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    alpha: bytes[25] === 6 || bytes[25] === 4,
  };
};

/**
 * The ffmpeg arguments that write the frames. `key` is "none" or a colour,
 * 0xRRGGBB (KEYS, or the one auto measured).
 * @param {{ input: string, out: string, key: string, from?: number,
 *   to?: number, speed?: number, fps: number, height: number,
 *   similarity: number, blend: number, crop?: string }} o
 */
export const ffmpegArgs = (o) => {
  const filters = [
    ...(o.crop ? [`crop=${o.crop}`] : []),
    ...(o.speed && o.speed !== 1 ? [`setpts=PTS/${o.speed}`] : []),
    `fps=${o.fps}`,
    `scale=-2:${o.height}:flags=lanczos`,
  ];
  if (o.key !== "none") {
    filters.push(
      `chromakey=${o.key}:${o.similarity}:${o.blend}`,
      `despill=type=${despillOf(o.key)}`,
    );
  }
  filters.push("format=rgba");
  return [
    "-v",
    "error",
    // ffmpeg's own VP9 decoder drops a WebM's alpha; libvpx keeps it.
    ...(o.key === "none" && o.input.endsWith(".webm")
      ? ["-c:v", "libvpx-vp9"]
      : []),
    ...(o.from !== undefined ? ["-ss", String(o.from)] : []),
    ...(o.to !== undefined ? ["-to", String(o.to)] : []),
    "-i",
    o.input,
    "-an",
    "-vf",
    filters.join(","),
    "-start_number",
    "1",
    join(o.out, "%04d.png"),
  ];
};

/** Run ffmpeg; its stdout as bytes. Stops the prep on an error. */
const ffmpegOut = (args, fail) => {
  const run = spawnSync("ffmpeg", ["-v", "error", ...args], {
    maxBuffer: 1 << 30,
  });
  if (run.status !== 0) {
    fail(`ffmpeg exited ${run.status}: ${run.stderr.toString().trim()}`);
  }
  return new Uint8Array(run.stdout);
};

/** Whether a video has a sound track. */
const hasAudio = (input) =>
  spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      input,
    ],
    { encoding: "utf8" },
  ).stdout.trim() !== "";

/** A video's length in seconds. */
const clipLength = (input) =>
  Number(
    spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        input,
      ],
      { encoding: "utf8" },
    ).stdout.trim(),
  );

/** The input part to keep, as ffmpeg input options. */
const cutArgs = (o) => [
  ...(o.from !== undefined ? ["-ss", String(o.from)] : []),
  ...(o.to !== undefined ? ["-to", String(o.to)] : []),
];

const main = () => {
  const { values: a } = parseArgs({
    options: {
      in: { type: "string" },
      dir: { type: "string" },
      key: { type: "string", default: "auto" },
      crop: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      speed: { type: "string", default: "1" },
      audio: { type: "string" },
      "spill-max": { type: "string", default: "0.01" },
      trim: { type: "boolean", default: false },
      fps: { type: "string", default: "30" },
      height: { type: "string", default: "540" },
      similarity: { type: "string", default: "0.15" },
      blend: { type: "string", default: "0.1" },
      replace: { type: "boolean", default: false },
    },
    strict: true,
  });
  const fail = (msg) => {
    console.error(`prepare-overlay-clip: ${msg}`);
    process.exit(2);
  };
  if (!a.in || !existsSync(a.in)) fail(`--in must be a video file`);
  if (!a.dir || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.dir)) {
    fail(`--dir must be a kebab-case name, got ${JSON.stringify(a.dir)}`);
  }
  if (
    !["auto", "green", "blue", "none"].includes(a.key) &&
    !/^0x[0-9A-Fa-f]{6}$/.test(a.key)
  ) {
    fail(`--key must be auto, green, blue, none or 0xRRGGBB`);
  }
  const num = (name, lo, hi) => {
    if (a[name] === undefined) return undefined;
    const v = Number(a[name]);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      fail(`--${name} must be ${lo}..${hi}`);
    }
    return v;
  };
  if (a.crop !== undefined && !/^\d+:\d+:\d+:\d+$/.test(a.crop)) {
    fail(`--crop must be W:H:X:Y in pixels, got ${JSON.stringify(a.crop)}`);
  }
  const input = resolve(a.in);
  const sound = a.audio ?? (hasAudio(input) ? "own" : "none");
  if (sound !== "own" && sound !== "none") fail(`--audio must be own or none`);
  if (sound === "own" && !hasAudio(input)) fail(`${a.in} has no sound track`);
  const o = {
    input,
    key: a.key,
    crop: a.crop,
    from: num("from", 0, 3600),
    to: num("to", 0, 3600),
    speed: num("speed", 0.25, 4),
    fps: num("fps", 1, 60),
    height: num("height", 64, 1920),
    similarity: num("similarity", 0.01, 1),
    blend: num("blend", 0, 1),
  };
  const spillMax = num("spill-max", 0, 1);
  if (o.from !== undefined && o.to !== undefined && o.to <= o.from) {
    fail(`--to must be after --from`);
  }
  if (a.key === "auto") {
    // KEY_SAMPLES frames across the part kept, small: their border is the
    // screen, unless the art fills it (Curtain Opening starts closed, all
    // red; 2026-10-31). The most screen-like border wins.
    const [w, h] = [64, 36];
    const span = (o.to ?? clipLength(input)) - (o.from ?? 0);
    const rgb = ffmpegOut(
      [
        ...cutArgs(o),
        "-i",
        input,
        "-vf",
        `${o.crop ? `crop=${o.crop},` : ""}fps=${KEY_SAMPLES / span},scale=${w}:${h}:flags=area`,
        "-frames:v",
        String(KEY_SAMPLES),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      fail,
    );
    const size = w * h * 3;
    const colours = [];
    for (let i = 0; i + size <= rgb.length; i += size) {
      colours.push(borderColor(rgb.subarray(i, i + size), w, h));
    }
    o.key = screenColor(colours);
    if (o.key === null) {
      fail(
        `no frame's border is a green or blue screen (${colours.join(", ")}): give --key`,
      );
    }
    console.log(
      `key colour (measured on the border of ${colours.length} frames): ${o.key}`,
    );
  } else if (a.key in KEYS) {
    o.key = KEYS[a.key];
  }
  const target = join(REPO, OVERLAY_CLIP_DIR, a.dir);
  if (existsSync(target) && !a.replace) {
    fail(
      `${OVERLAY_CLIP_DIR}/${a.dir} exists; give --replace to write over it`,
    );
  }

  const out = mkdtempSync(join(tmpdir(), "overlay-clip-"));
  try {
    const run = spawnSync("ffmpeg", ffmpegArgs({ ...o, out }), {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (run.status !== 0) fail(`ffmpeg exited ${run.status}`);
    const names = readdirSync(out)
      .filter((f) => f.endsWith(".png"))
      .sort();
    if (names.length === 0) fail(`ffmpeg wrote no frames`);
    const frames = names.map((f, i) => {
      if (f !== clipFrameFile(i)) fail(`frame ${i + 1} is ${f}`);
      return readFileSync(join(out, f));
    });
    const info = pngInfo(frames[0]);
    for (const [i, bytes] of frames.entries()) {
      const fi = pngInfo(bytes);
      if (fi.width !== info.width || fi.height !== info.height) {
        fail(
          `frame ${i + 1} is ${fi.width}x${fi.height}, not ${info.width}x${info.height}`,
        );
      }
      if (!fi.alpha) fail(`frame ${i + 1} has no alpha`);
    }
    // Every frame's pixels, once: for the trim and the green the key left.
    const readRaw = () =>
      ffmpegOut(
        [
          "-framerate",
          String(o.fps),
          "-i",
          join(out, "%04d.png"),
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "-",
        ],
        fail,
      );
    let raw = readRaw();
    if (a.trim) {
      const box = visibleBox(raw, frames.length, info.width, info.height);
      if (box === null) fail(`no frame has a visible pixel`);
      // ffmpeg writes the cropped frames over the old ones.
      const crop = join(out, "crop");
      mkdirSync(crop);
      ffmpegOut(
        [
          "-framerate",
          String(o.fps),
          "-i",
          join(out, "%04d.png"),
          "-vf",
          `crop=${box.w}:${box.h}:${box.x}:${box.y},format=rgba`,
          "-start_number",
          "1",
          join(crop, "%04d.png"),
        ],
        fail,
      );
      for (const [i, f] of names.entries()) {
        copyFileSync(join(crop, f), join(out, f));
        frames[i] = readFileSync(join(out, f));
      }
      rmSync(crop, { recursive: true });
      console.log(
        `trim: ${info.width}x${info.height} -> ${box.w}x${box.h} at ${box.x},${box.y}`,
      );
      Object.assign(info, pngInfo(frames[0]));
      raw = readRaw();
    }
    if (o.key !== "none") {
      const size = info.width * info.height * 4;
      let worst = { share: 0, frame: 1 };
      for (let i = 0; i < frames.length; i += 1) {
        const share = spillShare(raw.subarray(i * size, (i + 1) * size));
        if (share > worst.share) worst = { share, frame: i + 1 };
      }
      const pct = (worst.share * 100).toFixed(2);
      if (worst.share > spillMax) {
        fail(
          `frame ${worst.frame} keeps ${pct}% of its visible pixels green (at most ${(spillMax * 100).toFixed(2)}%): raise --similarity or --blend, or give --key`,
        );
      }
      console.log(`green spill: at most ${pct}% (frame ${worst.frame})`);
    }
    let audio = null;
    if (sound === "own") {
      // Bit-exact PCM, so the same cut gives the same sha256.
      const wav = join(out, CLIP_AUDIO_FILE);
      ffmpegOut(
        [
          ...cutArgs(o),
          "-i",
          input,
          "-vn",
          ...(o.speed !== 1 ? ["-af", `atempo=${o.speed}`] : []),
          "-ar",
          "48000",
          "-ac",
          "2",
          "-c:a",
          "pcm_s16le",
          "-fflags",
          "+bitexact",
          "-flags:a",
          "+bitexact",
          wav,
        ],
        fail,
      );
      const level = measureClip(wav);
      if (!Number.isFinite(level.truePeak) || level.lufs < SILENT_LUFS) {
        // Anime Zoom's track is silence: a clip with nothing to hear keeps
        // no sound, so an EDL cannot ask for it (2026-10-31).
        if (a.audio === "own") fail(`its sound is silent in the part kept`);
        rmSync(wav);
        console.log(`sound: silent in the part kept, so it keeps none`);
      } else {
        audio = {
          file: CLIP_AUDIO_FILE,
          sha256: sha256(readFileSync(wav)),
          ...level,
        };
        console.log(
          `sound: ${CLIP_AUDIO_FILE}, loudest 400 ms ${level.lufs} LUFS, true peak ${level.truePeak} dBTP`,
        );
      }
    }
    const version = spawnSync("ffmpeg", ["-version"], {
      encoding: "utf8",
    }).stdout.split("\n")[0];
    const manifest = clipManifestText({
      fps: o.fps,
      width: info.width,
      height: info.height,
      frames,
      audio,
      made: {
        input: basename(o.input),
        inputSha256: sha256(readFileSync(o.input)),
        key: o.key,
        // Only when given: a clip made without one keeps its manifest bytes.
        ...(o.crop ? { crop: o.crop } : {}),
        from: o.from ?? null,
        to: o.to ?? null,
        speed: o.speed,
        similarity: o.similarity,
        blend: o.blend,
        ffmpeg: version,
      },
    });
    writeFileSync(join(out, "manifest.json"), manifest);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const f of [
      ...names,
      ...(audio ? [CLIP_AUDIO_FILE] : []),
      "manifest.json",
    ]) {
      copyFileSync(join(out, f), join(target, f));
    }
    const seconds = names.length / o.fps;
    console.log(
      `${OVERLAY_CLIP_DIR}/${a.dir}: ${names.length} frames, ${info.width}x${info.height}, ${seconds.toFixed(2)} s`,
    );
    console.log("For its OVERLAYS entry:");
    console.log(
      `  seconds: ${Number(seconds.toFixed(3))},\n  sequence: { dir: "${a.dir}", fps: ${o.fps}, frames: ${names.length}, sha256: "${sha256(manifest)}"${audio ? ", audio: true" : ""} },\n  size: { w: <board fraction>, h: <board fraction> }, // the clip is ${info.width}x${info.height}`,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

if (import.meta.main) main();
