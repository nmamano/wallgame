import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO } from "./render-kit.mjs";
import {
  creditLine,
  creditLines,
  mayPlay,
  musicGain,
  MUSIC_MEASURE_SECONDS,
  MUSIC_REFERENCE_LUFS,
  MUSIC_TRACKS,
  SOUNDS_CREDIT,
} from "./music-tracks.mjs";

describe("the music license table", () => {
  test("gives every track a known status and a credit", () => {
    for (const t of MUSIC_TRACKS) {
      expect(["ok", "ok-with-credit", "blocked-until-nil"]).toContain(
        t.license,
      );
      expect(t.credit.length).toBeGreaterThan(0);
    }
  });

  test("lets a video play only an ok or ok-with-credit track", () => {
    const status = Object.fromEntries(
      MUSIC_TRACKS.map((t) => [t.slug, mayPlay(t)]),
    );
    // MUSIC-LICENSES.md, 2026-10-28: the Uppbeat tracks wait for Nil.
    expect(status).toEqual({
      "deja-vus": true,
      "tea-for-two": false,
      "a-legend": false,
      skippy: false,
    });
  });

  test("builds one credit line: each track in play order, then the game sounds", () => {
    const track = (slug: string) => MUSIC_TRACKS.find((t) => t.slug === slug)!;
    expect(creditLine([track("deja-vus")])).toBe(
      "Music: Deja Vus by YannZ (CC BY 4.0) · Sounds: JDSherbert",
    );
    expect(creditLine([track("a-legend"), track("deja-vus")])).toBe(
      "Music: A Legend by Ian Aisling (Uppbeat), Deja Vus by YannZ (CC BY 4.0) · Sounds: JDSherbert",
    );
    expect(creditLines([track("a-legend"), track("deja-vus")])).toEqual([
      "Music: A Legend by Ian Aisling (Uppbeat)",
      "Deja Vus by YannZ (CC BY 4.0) · Sounds: JDSherbert",
    ]);
    expect(creditLine([])).toBe(SOUNDS_CREDIT);
  });
});

describe("the music level", () => {
  test("plays deja-vus as before, and every track at its level", () => {
    const deja = MUSIC_TRACKS.find((t) => t.slug === "deja-vus")!;
    expect(deja.lufs).toBe(MUSIC_REFERENCE_LUFS);
    expect(musicGain(deja)).toBe(1);
    // A track given by path has no measure: it plays as it is.
    expect(musicGain({})).toBe(1);
    for (const t of MUSIC_TRACKS) {
      const level = t.lufs + 20 * Math.log10(musicGain(t));
      expect(level).toBeCloseTo(MUSIC_REFERENCE_LUFS, 9);
    }
  });

  // CI installs ffmpeg (ci.yml); a box without it skips.
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  test.skipIf(!hasFfmpeg)(
    "each lufs is the file's, measured",
    () => {
      for (const t of MUSIC_TRACKS) {
        const run = spawnSync(
          "ffmpeg",
          [
            "-nostdin",
            "-hide_banner",
            "-t",
            String(MUSIC_MEASURE_SECONDS),
            "-i",
            join(REPO, "frontend/public/audio/songs", t.file),
            "-af",
            "ebur128",
            "-f",
            "null",
            "-",
          ],
          { encoding: "utf8" },
        );
        const summary = run.stderr.slice(run.stderr.lastIndexOf("Summary:"));
        const measured = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)![1]);
        // Within 0.1 LU: another ffmpeg build may round the last digit.
        expect([t.slug, Math.abs(measured - t.lufs) <= 0.1]).toEqual([
          t.slug,
          true,
        ]);
      }
    },
    60_000,
  );
});
