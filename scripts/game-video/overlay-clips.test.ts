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
  CLIP_AUDIO_FILE,
  OVERLAY_CLIP_DIR,
  boardToCover,
  clipCoverage,
  clipFrameIndex,
  clipManifestText,
  coverOver,
  loadClip,
  sha256,
} from "./overlay-clips.mjs";
import {
  borderColor,
  despillOf,
  ffmpegArgs,
  pngInfo,
  screenColor,
  spillShare,
  visibleBox,
} from "./prepare-overlay-clip.mjs";

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
            key: "0x00FF00",
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
        // Its coverage grid: the box (the middle quarter of the frame, 40
        // of 160 px wide) covers the middle, nothing covers a corner.
        const cov = clipCoverage(
          names.map((f) => join(out, f)),
          160,
          120,
          16,
        );
        expect([cov.cols, cov.rows, cov.grids.length]).toEqual([16, 12, 10]);
        const box = { x0: 0.45, y0: 0.4, x1: 0.55, y1: 0.6 };
        expect(coverOver(cov.grids[0], 16, 12, box)).toBeGreaterThan(0.9);
        const corner = { x0: 0, y0: 0, x1: 0.2, y1: 0.2 };
        expect(coverOver(cov.grids[0], 16, 12, corner)).toBeLessThan(0.01);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    },
  );

  test("a clip with its own sound pins it, and stops on a change", () => {
    const repo = mkdtempSync(join(tmpdir(), "clip-test-"));
    try {
      const dir = join(repo, OVERLAY_CLIP_DIR, "s");
      mkdirSync(dir, { recursive: true });
      const frame = new TextEncoder().encode("frame");
      writeFileSync(join(dir, "0001.png"), frame);
      writeFileSync(join(dir, CLIP_AUDIO_FILE), "sound");
      const audio = {
        file: CLIP_AUDIO_FILE,
        sha256: sha256(new TextEncoder().encode("sound")),
        lufs: -20,
        truePeak: -6,
      };
      const text = clipManifestText({
        fps: 30,
        width: 8,
        height: 8,
        frames: [frame],
        audio,
        made: {},
      });
      writeFileSync(join(dir, "manifest.json"), text);
      const seq = {
        dir: "s",
        fps: 30,
        frames: 1,
        sha256: sha256(text),
        audio: true as const,
      };
      expect(loadClip("s", seq, repo).audio).toEqual({
        ...audio,
        path: join(dir, CLIP_AUDIO_FILE),
      });
      // Without `audio` in the registry, the sound is not loaded.
      expect(loadClip("s", { ...seq, audio: undefined }, repo).audio).toBe(
        null,
      );
      writeFileSync(join(dir, CLIP_AUDIO_FILE), "another sound");
      expect(() => loadClip("s", seq, repo)).toThrow(
        /overlay s: audio.wav is [0-9a-f]{64}, its manifest says/,
      );
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test("a registry sound the manifest lacks stops the render", () => {
    const { repo, seq } = fixture();
    try {
      expect(() => loadClip("c", { ...seq, audio: true }, repo)).toThrow(
        /has its own sound, and its manifest names none/,
      );
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test("the screen's colour is the border's, and the greenest border wins", () => {
    // 4x3: a dark green border round two red pixels.
    const px = (r: number, g: number, b: number) => [r, g, b];
    const g = px(0, 169, 0);
    const red = px(200, 0, 0);
    const rgb = new Uint8Array([g, g, g, g, g, red, red, g, g, g, g, g].flat());
    expect(borderColor(rgb, 4, 3)).toBe("0x00A900");
    // Curtain Opening: its first frames are all curtain, red at the border.
    expect(screenColor(["0xC00606", "0x14DA01", "0x40A040"])).toBe("0x14DA01");
    expect(screenColor(["0xC00606", "0x808080"])).toBe(null);
    expect(screenColor(["0x1010F0"])).toBe("0x1010F0");
    expect(despillOf("0x54FF00")).toBe("green");
    expect(despillOf("0x1010F0")).toBe("blue");
  });

  test("spill is the share of visible pixels that stay green", () => {
    const rgba = new Uint8Array(
      [
        [0, 255, 0, 0], // keyed out: not visible
        [20, 200, 20, 255], // green: spill
        [200, 30, 30, 255], // red art
        [120, 150, 120, 255], // greyish green, inside the margin
      ].flat(),
    );
    expect(spillShare(rgba)).toBeCloseTo(1 / 3, 6);
    expect(spillShare(new Uint8Array([0, 255, 0, 0]))).toBe(0);
  });

  test("the trim box holds every frame's visible pixels, with even sides", () => {
    // Two 4x4 frames: a pixel at (1,1) in one, at (2,2) in the other.
    const frames = new Uint8Array(2 * 4 * 4 * 4);
    frames[(1 * 4 + 1) * 4 + 3] = 255;
    frames[64 + (2 * 4 + 2) * 4 + 3] = 255;
    expect(visibleBox(frames, 2, 4, 4)).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    // One pixel at the right edge widens to the left.
    const edge = new Uint8Array(4 * 4 * 4);
    edge[(0 * 4 + 3) * 4 + 3] = 255;
    expect(visibleBox(edge, 1, 4, 4)).toEqual({ x: 2, y: 0, w: 2, h: 2 });
    expect(visibleBox(new Uint8Array(64), 1, 4, 4)).toBe(null);
  });

  test("a cover clip's pixels map to the board as object-fit: cover draws it", () => {
    // A 16:9 clip on a square board shows its middle 9/16 of its width.
    const all = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const wide = boardToCover(all, 1, 16 / 9);
    expect(wide.x0).toBeCloseTo((1 - 9 / 16) / 2, 9);
    expect(wide.x1).toBeCloseTo(1 - (1 - 9 / 16) / 2, 9);
    expect([wide.y0, wide.y1]).toEqual([0, 1]);
    // A tall board shows the middle of a square clip's width too.
    const tall = boardToCover({ x0: 0.5, y0: 0, x1: 1, y1: 0.5 }, 0.5, 1);
    expect([tall.x0, tall.x1, tall.y0, tall.y1]).toEqual([0.5, 0.75, 0, 0.5]);
    // A board wider than the clip cuts its top and bottom instead.
    // Stretched ("fill"), a box is the same share of the clip.
    expect(boardToCover(tall, 0.5, 16 / 9, "fill")).toEqual(tall);
    const flat = boardToCover(all, 2, 1);
    expect([flat.x0, flat.x1, flat.y0, flat.y1]).toEqual([0, 1, 0.25, 0.75]);
  });

  test("coverOver weighs each grid cell by its share of the box", () => {
    // 2x1: an opaque cell and a clear one.
    const grid = new Uint8Array([255, 0]);
    expect(coverOver(grid, 2, 1, { x0: 0, y0: 0, x1: 1, y1: 1 })).toBe(0.5);
    expect(coverOver(grid, 2, 1, { x0: 0.25, y0: 0, x1: 0.75, y1: 1 })).toBe(
      0.5,
    );
    expect(coverOver(grid, 2, 1, { x0: 0, y0: 0, x1: 0.5, y1: 1 })).toBe(1);
    expect(coverOver(grid, 2, 1, { x0: 1.2, y0: 0, x1: 1.5, y1: 1 })).toBe(0);
  });
});
