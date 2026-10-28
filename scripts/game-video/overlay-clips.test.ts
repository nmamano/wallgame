import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OVERLAY_CLIP_DIR,
  clipFrameIndex,
  clipManifestText,
  loadClip,
  sha256,
} from "./overlay-clips.mjs";
import { ffmpegArgs, pngInfo } from "./prepare-overlay-clip.mjs";

/** A clip of `n` frames in a fresh repo, and the registry entry that pins it. */
const fixture = (n = 3) => {
  const repo = mkdtempSync(join(tmpdir(), "clip-test-"));
  const dir = join(repo, OVERLAY_CLIP_DIR, "c");
  mkdirSync(dir, { recursive: true });
  const frames = Array.from({ length: n }, (_, i) =>
    new TextEncoder().encode(`frame ${i}`),
  );
  frames.forEach((b, i) =>
    writeFileSync(join(dir, `${String(i + 1).padStart(4, "0")}.png`), b),
  );
  const text = clipManifestText({
    fps: 30,
    width: 8,
    height: 8,
    frames,
    made: { input: "x.mp4" },
  });
  writeFileSync(join(dir, "manifest.json"), text);
  const seq = { dir: "c", fps: 30, frames: n, sha256: sha256(text) };
  return { repo, dir, seq };
};

describe("overlay clips", () => {
  test("a clip shows frame floor(t * fps), then holds its last", () => {
    expect(clipFrameIndex(0, 30, 45)).toBe(0);
    // 10 / 30 is a whole frame, though 10 * (1 / 30) * 30 is 9.999...
    expect(clipFrameIndex(10 * (1 / 30), 30, 45)).toBe(10);
    expect(clipFrameIndex(0.049, 30, 45)).toBe(1);
    expect(clipFrameIndex(1.5, 30, 45)).toBe(44);
    expect(clipFrameIndex(9, 30, 45)).toBe(44);
    expect(clipFrameIndex(-0.1, 30, 45)).toBe(0);
  });

  test("loads the frames the registry pins", () => {
    const { repo, dir, seq } = fixture();
    try {
      const clip = loadClip("c", seq, repo);
      expect(clip.fps).toBe(30);
      expect(clip.files).toEqual(
        ["0001.png", "0002.png", "0003.png"].map((f) => join(dir, f)),
      );
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test("stops on a changed frame, manifest or count", () => {
    const { repo, dir, seq } = fixture();
    try {
      writeFileSync(join(dir, "0002.png"), "another frame");
      expect(() => loadClip("c", seq, repo)).toThrow(
        /overlay c: 0002.png is [0-9a-f]{64}, its manifest says/,
      );
      expect(() => loadClip("c", { ...seq, sha256: "ab" }, repo)).toThrow(
        "the registry pins ab; the clip changed since it was rated",
      );
      expect(() => loadClip("c", { ...seq, frames: 4 }, repo)).toThrow(
        "its manifest has 3 frames at 30 fps, the registry says 4 at 30",
      );
      rmSync(join(dir, "0003.png"));
      writeFileSync(join(dir, "0002.png"), "frame 1");
      expect(() => loadClip("c", seq, repo)).toThrow("0003.png is missing");
      expect(() => loadClip("c", { ...seq, dir: "none" }, repo)).toThrow(
        "assets/overlays/none/manifest.json is missing here",
      );
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  // CI installs ffmpeg (ci.yml); a box without it skips.
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  test.skipIf(!hasFfmpeg)(
    "keys a green screen to alpha, at the asked height and fps",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "clip-key-"));
      try {
        // One second of a green screen with a red box in its middle.
        const input = join(tmp, "in.mp4");
        const make = spawnSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=0x00FF00:s=320x240:r=30:d=1",
          "-vf",
          "drawbox=x=120:y=80:w=80:h=80:c=red:t=fill",
          "-pix_fmt",
          "yuv420p",
          input,
        ]);
        expect(make.status).toBe(0);
        const out = join(tmp, "out");
        mkdirSync(out);
        const run = spawnSync(
          "ffmpeg",
          ffmpegArgs({
            input,
            out,
            key: "green",
            from: 0.5,
            fps: 20,
            height: 120,
            similarity: 0.15,
            blend: 0.1,
          }),
        );
        expect(run.status).toBe(0);
        const names = readdirSync(out).sort();
        expect(names.length).toBe(10);
        expect(names[0]).toBe("0001.png");
        const png = readFileSync(join(out, names[0]));
        expect(pngInfo(png)).toEqual({ width: 160, height: 120, alpha: true });
        // The corner is keyed out; the box's middle stays opaque.
        const raw = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            join(out, names[0]),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
          ],
          { maxBuffer: 1 << 20 },
        ).stdout;
        const alphaAt = (x: number, y: number) => raw[(y * 160 + x) * 4 + 3];
        expect(alphaAt(2, 2)).toBe(0);
        expect(alphaAt(80, 60)).toBe(255);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    },
  );
});
