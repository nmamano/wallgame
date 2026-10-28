/**
 * Make a "sequence" overlay's frames (overlay-clips.mjs) from a clip:
 * a green-screen (or blue-screen) video keyed to alpha, or a video that has
 * alpha already (a VP9 WebM, a ProRes 4444 MOV).
 *
 *   bun scripts/game-video/prepare-overlay-clip.mjs --in <video> --dir <name>
 *     [--key green|blue|none]  the screen colour to key out (default green)
 *     [--from <s>] [--to <s>]  the part of the video to keep
 *     [--fps <n>]              frames a second (default 30, the video's)
 *     [--height <px>]          the frames' height (default 540)
 *     [--similarity <0..1>]    how far from the key colour still keys out
 *     [--blend <0..1>]         the soft edge around it
 *     [--replace]              write over an existing clip of that name
 *
 * It writes assets/overlays/<name>/NNNN.png and manifest.json, and prints
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
import {
  OVERLAY_CLIP_DIR,
  clipFrameFile,
  clipManifestText,
  sha256,
} from "./overlay-clips.mjs";

const KEYS = {
  green: "0x00FF00",
  blue: "0x0000FF",
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
 * The ffmpeg arguments that write the frames.
 * @param {{ input: string, out: string, key: string, from?: number,
 *   to?: number, fps: number, height: number, similarity: number,
 *   blend: number }} o
 */
export const ffmpegArgs = (o) => {
  const filters = [`fps=${o.fps}`, `scale=-2:${o.height}:flags=lanczos`];
  if (o.key !== "none") {
    filters.push(
      `chromakey=${KEYS[o.key]}:${o.similarity}:${o.blend}`,
      `despill=type=${o.key}`,
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

const main = () => {
  const { values: a } = parseArgs({
    options: {
      in: { type: "string" },
      dir: { type: "string" },
      key: { type: "string", default: "green" },
      from: { type: "string" },
      to: { type: "string" },
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
  if (!["green", "blue", "none"].includes(a.key)) {
    fail(`--key must be green, blue or none`);
  }
  const num = (name, lo, hi) => {
    if (a[name] === undefined) return undefined;
    const v = Number(a[name]);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      fail(`--${name} must be ${lo}..${hi}`);
    }
    return v;
  };
  const o = {
    input: resolve(a.in),
    key: a.key,
    from: num("from", 0, 3600),
    to: num("to", 0, 3600),
    fps: num("fps", 1, 60),
    height: num("height", 64, 1920),
    similarity: num("similarity", 0.01, 1),
    blend: num("blend", 0, 1),
  };
  if (o.from !== undefined && o.to !== undefined && o.to <= o.from) {
    fail(`--to must be after --from`);
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
    const version = spawnSync("ffmpeg", ["-version"], {
      encoding: "utf8",
    }).stdout.split("\n")[0];
    const manifest = clipManifestText({
      fps: o.fps,
      width: info.width,
      height: info.height,
      frames,
      made: {
        input: basename(o.input),
        inputSha256: sha256(readFileSync(o.input)),
        key: o.key,
        from: o.from ?? null,
        to: o.to ?? null,
        similarity: o.similarity,
        blend: o.blend,
        ffmpeg: version,
      },
    });
    writeFileSync(join(out, "manifest.json"), manifest);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const f of [...names, "manifest.json"]) {
      copyFileSync(join(out, f), join(target, f));
    }
    const seconds = names.length / o.fps;
    console.log(
      `${OVERLAY_CLIP_DIR}/${a.dir}: ${names.length} frames, ${info.width}x${info.height}, ${seconds.toFixed(2)} s`,
    );
    console.log("For its OVERLAYS entry:");
    console.log(
      `  seconds: ${Number(seconds.toFixed(3))},\n  sequence: { dir: "${a.dir}", fps: ${o.fps}, frames: ${names.length}, sha256: "${sha256(manifest)}" },\n  size: { w: <board fraction>, h: <board fraction> }, // the clip is ${info.width}x${info.height}`,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

if (import.meta.main) main();
