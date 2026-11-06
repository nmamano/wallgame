import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KNOWN_FADE_OUTS,
  MEME_FAMILIES,
  MEME_SOUNDS,
  OUR_CUTS,
  VOICE_FAMILIES,
  VOICE_KEYS,
  isVoice,
} from "./meme-sounds.mjs";

describe("meme sounds", () => {
  test("every voice family is a family of the table", () => {
    expect(VOICE_FAMILIES.filter((f) => !(f in MEME_FAMILIES))).toEqual([]);
  });

  test("a voice is a sound with spoken words: a voice family, or one clip of a mixed family", () => {
    expect(VOICE_KEYS.filter((k) => !(k in MEME_SOUNDS))).toEqual([]);
    expect(isVoice("win-1")).toBe(true); // "Emotional damage"
    expect(isVoice("win-2")).toBe(false); // the GTA jingle
    expect(isVoice("fuahhh-2")).toBe(true);
    expect(isVoice("scared-1")).toBe(true); // "oh no"
    expect(isVoice("scared-2")).toBe(false); // a scream
    expect(isVoice("ooh-1")).toBe(false); // a crowd off screen
    expect(isVoice("ambulance-1")).toBe(true);
  });

  test("each of our cuts ends in silence or at its upload's end, or is a known fade-out", () => {
    const cuts = Object.entries(OUR_CUTS);
    expect(cuts.filter(([key]) => !(key in MEME_SOUNDS))).toEqual([]);
    expect(
      cuts
        .filter(([, cut]) => cut.end === "fade")
        .map(([key]) => key)
        .sort(),
    ).toEqual(Object.keys(KNOWN_FADE_OUTS).sort());
    expect(
      cuts.filter(
        ([, cut]) => !["silence", "file-end", "fade"].includes(cut.end),
      ),
    ).toEqual([]);
  });

  test("every cut in meme-sounds.md's Made from tables is in OUR_CUTS", () => {
    // A row of a "| Key | Made from |" table: our cut of a file, unless it
    // is made by ffmpeg with no input.
    const doc = readFileSync(join(import.meta.dir, "meme-sounds.md"), "utf8");
    const made: string[] = [];
    let inTable = false;
    for (const line of doc.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (/^\|\s*Key\s*\|\s*Made from\s*\|/.test(line)) inTable = true;
      else if (!line.startsWith("|")) inTable = false;
      else if (inTable && !/^-+$/.test(cells[1] ?? "")) {
        if (!(cells[2] ?? "").startsWith("ffmpeg (no input)")) {
          made.push(cells[1] ?? "");
        }
      }
    }
    expect(made.length).toBeGreaterThan(15);
    expect(made.filter((key) => !(key in OUR_CUTS))).toEqual([]);
    expect(Object.keys(OUR_CUTS).filter((key) => !made.includes(key))).toEqual(
      [],
    );
  });
});
