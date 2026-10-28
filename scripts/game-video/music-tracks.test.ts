import { describe, expect, test } from "bun:test";
import {
  creditLine,
  mayPlay,
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

  test("builds one credit line: the track, then the game sounds", () => {
    const dejaVus = MUSIC_TRACKS.find((t) => t.slug === "deja-vus");
    expect(creditLine(dejaVus)).toBe(
      "Music: Deja Vus by YannZ (CC BY 4.0) · Sounds: JDSherbert",
    );
    expect(creditLine(null)).toBe(SOUNDS_CREDIT);
  });
});
