/**
 * The frames of a "sequence" overlay (overlays.mjs): a short clip with
 * alpha, kept as a PNG sequence so the renderer can show the exact frame
 * of each moment (Wall Game Director, 2026-10-28: a reaction cut-out over
 * the board, in time with its sound).
 *
 * The clips are not in this repository: like the meme sounds, an outside
 * clip is someone else's upload. Each lives in the gitignored
 * assets/overlays/<dir>/, as prepare-overlay-clip.mjs writes it:
 *
 *   0001.png ...  the frames, RGBA, all one size
 *   audio.wav     its sound, when it keeps one (Wall Game PM, 2026-10-31:
 *                 a clip plays "its own audio or muted")
 *   manifest.json {fps, width, height, frames: [{file, sha256}],
 *                 audio?: {file, sha256, lufs, truePeak}, made}
 *
 * The registry entry pins the manifest's sha256, and the manifest pins each
 * frame's, so a clip Nil rated is the clip that renders: one changed byte
 * stops the render (loadClip).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OVERLAY_CLIP_DIR = "assets/overlays";

/** A clip's sound, next to its frames. */
export const CLIP_AUDIO_FILE = "audio.wav";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** A frame's file name: 1-based, four digits, as ffmpeg's %04d writes it. */
export const clipFrameFile = (i) => `${String(i + 1).padStart(4, "0")}.png`;

/**
 * The manifest of a clip, as the bytes prepare-overlay-clip.mjs writes:
 * one stable JSON text, so the same frames give the same sha256.
 * @param {{ fps: number, width: number, height: number,
 *   frames: Uint8Array[], audio?: ClipAudio | null,
 *   made: Record<string, unknown> }} clip
 */
export const clipManifestText = ({
  fps,
  width,
  height,
  frames,
  audio = null,
  made,
}) =>
  JSON.stringify(
    {
      fps,
      width,
      height,
      frames: frames.map((bytes, i) => ({
        file: clipFrameFile(i),
        sha256: sha256(bytes),
      })),
      ...(audio ? { audio } : {}),
      made,
    },
    null,
    2,
  ) + "\n";

/**
 * The frame a clip shows `t` seconds after it opens: frame floor(t * fps),
 * and the last frame after the clip's end. The small slack keeps a time
 * that is a whole frame in exact arithmetic (10 / 30 is 0.33333...) on that
 * frame, not the one before it.
 */
export const clipFrameIndex = (t, fps, count) =>
  Math.min(count - 1, Math.max(0, Math.floor(t * fps + 1e-6)));

/**
 * @typedef {{ file: string, sha256: string, lufs: number, truePeak: number }} ClipAudio
 */

/**
 * A sequence asset's frames, checked: the manifest is the one the registry
 * pins, it agrees with the registry's fps and frame count, and each frame's
 * bytes are the ones the manifest names. Throws, naming the first thing
 * that differs, so a render never shows a clip nobody rated.
 * @param {string} name the asset's key in OVERLAYS
 * With `seq.audio`, its sound too: the manifest names one, and its bytes are
 * the ones the manifest pins.
 * @param {{ dir: string, fps: number, frames: number, sha256: string, audio?: true }} seq
 * @param {string} repo
 * @returns {{ fps: number, width: number, height: number, files: string[],
 *   audio: (ClipAudio & { path: string }) | null }}
 */
export const loadClip = (name, seq, repo) => {
  const dir = join(repo, OVERLAY_CLIP_DIR, seq.dir);
  const manifestFile = join(dir, "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new Error(
      `overlay ${name}: ${OVERLAY_CLIP_DIR}/${seq.dir}/manifest.json is missing here; make it with prepare-overlay-clip.mjs and sync the render kit`,
    );
  }
  const text = readFileSync(manifestFile);
  const got = sha256(text);
  if (got !== seq.sha256) {
    throw new Error(
      `overlay ${name}: its manifest is ${got}, the registry pins ${seq.sha256}; the clip changed since it was rated`,
    );
  }
  const manifest = JSON.parse(text.toString("utf8"));
  if (manifest.fps !== seq.fps || manifest.frames.length !== seq.frames) {
    throw new Error(
      `overlay ${name}: its manifest has ${manifest.frames.length} frames at ${manifest.fps} fps, the registry says ${seq.frames} at ${seq.fps}`,
    );
  }
  const files = manifest.frames.map((f, i) => {
    if (f.file !== clipFrameFile(i)) {
      throw new Error(
        `overlay ${name}: frame ${i + 1} is ${f.file}, not ${clipFrameFile(i)}`,
      );
    }
    const file = join(dir, f.file);
    if (!existsSync(file)) {
      throw new Error(`overlay ${name}: ${f.file} is missing`);
    }
    const h = sha256(readFileSync(file));
    if (h !== f.sha256) {
      throw new Error(
        `overlay ${name}: ${f.file} is ${h}, its manifest says ${f.sha256}`,
      );
    }
    return file;
  });
  let audio = null;
  if (seq.audio) {
    const a = manifest.audio;
    if (!a) {
      throw new Error(
        `overlay ${name}: the registry says it has its own sound, and its manifest names none`,
      );
    }
    const path = join(dir, a.file);
    if (!existsSync(path)) {
      throw new Error(`overlay ${name}: ${a.file} is missing`);
    }
    const h = sha256(readFileSync(path));
    if (h !== a.sha256) {
      throw new Error(
        `overlay ${name}: ${a.file} is ${h}, its manifest says ${a.sha256}`,
      );
    }
    audio = { ...a, path };
  }
  return {
    fps: manifest.fps,
    width: manifest.width,
    height: manifest.height,
    files,
    audio,
  };
};

/** The columns of a clip's coverage grid (clipCoverage). */
export const COVERAGE_COLUMNS = 96;

/**
 * Each frame's alpha as a coarse grid: `cols` columns, rows to the frame's
 * shape, each cell the mean alpha (0..255) of the pixels in it. The pawn
 * test of a board-wide clip reads it (coverOver): a confetti shower or
 * speed lines are a box over the whole board, and what they hide is
 * measured from their pixels, not their box (Wall Game PM, 2026-10-31:
 * "hides no pawn").
 * @param {string[]} files the frames, in order
 * @param {number} width
 * @param {number} height
 * @param {number} [cols]
 * @returns {{ cols: number, rows: number, grids: Uint8Array[] }}
 */
export const clipCoverage = (files, width, height, cols = COVERAGE_COLUMNS) => {
  const rows = Math.max(1, Math.round((cols * height) / width));
  const dir = dirname(files[0]);
  const run = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-start_number",
      "1",
      "-i",
      join(dir, "%04d.png"),
      "-frames:v",
      String(files.length),
      "-vf",
      `alphaextract,scale=${cols}:${rows}:flags=area`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { maxBuffer: 1 << 28 },
  );
  if (run.status !== 0) {
    throw new Error(
      `the coverage of ${dir}: ffmpeg exited ${run.status}: ${run.stderr.toString().trim()}`,
    );
  }
  const bytes = new Uint8Array(run.stdout);
  const size = cols * rows;
  if (bytes.length !== size * files.length) {
    throw new Error(
      `the coverage of ${dir}: ${bytes.length} bytes for ${files.length} frames of ${cols}x${rows}`,
    );
  }
  return {
    cols,
    rows,
    grids: files.map((_, i) => bytes.subarray(i * size, (i + 1) * size)),
  };
};

/**
 * How much of `box` (in the clip, 0..1) one frame's grid covers: the mean
 * alpha of the grid cells it overlaps, each weighted by the share of it
 * inside the box, as 0..1.
 * @param {Uint8Array} grid
 * @param {number} cols
 * @param {number} rows
 * @param {{ x0: number, y0: number, x1: number, y1: number }} box
 */
export const coverOver = (grid, cols, rows, box) => {
  const x0 = Math.max(0, box.x0 * cols);
  const x1 = Math.min(cols, box.x1 * cols);
  const y0 = Math.max(0, box.y0 * rows);
  const y1 = Math.min(rows, box.y1 * rows);
  if (x1 <= x0 || y1 <= y0) return 0;
  let sum = 0;
  let area = 0;
  for (let r = Math.floor(y0); r < Math.ceil(y1); r += 1) {
    const h = Math.min(r + 1, y1) - Math.max(r, y0);
    for (let c = Math.floor(x0); c < Math.ceil(x1); c += 1) {
      const w = Math.min(c + 1, x1) - Math.max(c, x0);
      sum += grid[r * cols + c] * w * h;
      area += w * h;
    }
  }
  return sum / area / 255;
};

/**
 * A box in the board (0..1) as a share of a clip drawn over the whole board
 * with object-fit: cover (stage.html, #overlay.sequence.cover): the clip is
 * scaled to fill the board and centred, so its overflow is cut equally on
 * both sides. `board` and `clip` are width / height.
 * @param {{ x0: number, y0: number, x1: number, y1: number }} box
 * @param {number} board
 * @param {number} clip
 */
export const boardToCover = (box, board, clip) => {
  // In the clip's shares: the board shows a centred window of it.
  const [sx, sy] = clip > board ? [board / clip, 1] : [1, clip / board];
  const ox = (1 - sx) / 2;
  const oy = (1 - sy) / 2;
  return {
    x0: ox + box.x0 * sx,
    y0: oy + box.y0 * sy,
    x1: ox + box.x1 * sx,
    y1: oy + box.y1 * sy,
  };
};
