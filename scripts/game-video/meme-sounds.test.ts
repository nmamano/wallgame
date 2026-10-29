import { describe, expect, test } from "bun:test";
import { MEME_FAMILIES, VOICE_FAMILIES } from "./meme-sounds.mjs";

describe("meme sounds", () => {
  test("every voice family is a family of the table", () => {
    expect(VOICE_FAMILIES.filter((f) => !(f in MEME_FAMILIES))).toEqual([]);
  });
});
