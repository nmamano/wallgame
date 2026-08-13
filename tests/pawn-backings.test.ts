import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PAWN_TYPES = ["dog", "cat", "mouse", "elephant", "home"] as const;

describe("generated pawn backings", () => {
  for (const type of PAWN_TYPES) {
    test(`${type} has one backing for every SVG`, () => {
      const sourceNames = readdirSync(
        path.join(ROOT, "frontend/public/pawns", type),
      )
        .filter((name) => name.endsWith(".svg"))
        .map((name) => name.replace(/\.svg$/, ".png"))
        .sort();
      const backingNames = readdirSync(
        path.join(ROOT, "frontend/public/pawn-backings", type),
      )
        .filter((name) => name.endsWith(".png"))
        .sort();

      expect(backingNames).toEqual(sourceNames);
    });
  }
});
