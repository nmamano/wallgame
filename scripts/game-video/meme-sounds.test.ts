import { describe, expect, test } from "bun:test";
import {
  MEME_FAMILIES,
  MEME_SOUNDS,
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
});
