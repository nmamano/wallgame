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
 *   manifest.json {fps, width, height, frames: [{file, sha256}], made}
 *
 * The registry entry pins the manifest's sha256, and the manifest pins each
 * frame's, so a clip Nil rated is the clip that renders: one changed byte
 * stops the render (loadClip).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OVERLAY_CLIP_DIR = "assets/overlays";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** A frame's file name: 1-based, four digits, as ffmpeg's %04d writes it. */
export const clipFrameFile = (i) => `${String(i + 1).padStart(4, "0")}.png`;

/**
 * The manifest of a clip, as the bytes prepare-overlay-clip.mjs writes:
 * one stable JSON text, so the same frames give the same sha256.
 * @param {{ fps: number, width: number, height: number,
 *   frames: Uint8Array[], made: Record<string, unknown> }} clip
 */
export const clipManifestText = ({ fps, width, height, frames, made }) =>
  JSON.stringify(
    {
      fps,
      width,
      height,
      frames: frames.map((bytes, i) => ({
        file: clipFrameFile(i),
        sha256: sha256(bytes),
      })),
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
 * A sequence asset's frames, checked: the manifest is the one the registry
 * pins, it agrees with the registry's fps and frame count, and each frame's
 * bytes are the ones the manifest names. Throws, naming the first thing
 * that differs, so a render never shows a clip nobody rated.
 * @param {string} name the asset's key in OVERLAYS
 * @param {{ dir: string, fps: number, frames: number, sha256: string }} seq
 * @param {string} repo
 * @returns {{ fps: number, width: number, height: number, files: string[] }}
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
  return {
    fps: manifest.fps,
    width: manifest.width,
    height: manifest.height,
    files,
  };
};
