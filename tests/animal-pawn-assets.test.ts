import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const names = (type: "dog" | "elephant") =>
  readdirSync(path.join(ROOT, "frontend/public/pawns", type))
    .filter((name) => name.endsWith(".svg"))
    .sort();

describe("purchased animal pawn completeness and sanitation", () => {
  test("contains every numbered individual design and no combined sheet", () => {
    expect(names("dog").sort()).toEqual(
      [
        ...Array.from(
          { length: 24 },
          (_, index) =>
            `dog-one-line-${String(index + 2).padStart(2, "0")}.svg`,
        ),
        ...Array.from(
          { length: 25 },
          (_, index) => `dog-puppy-${String(index + 1).padStart(2, "0")}.svg`,
        ),
      ].sort(),
    );
    expect(names("elephant")).toEqual(
      Array.from(
        { length: 25 },
        (_, index) => `elephant-${String(index + 1).padStart(2, "0")}.svg`,
      ),
    );
  });

  test("contains only sanitized local path geometry", () => {
    for (const type of ["dog", "elephant"] as const) {
      for (const name of names(type)) {
        const svg = readFileSync(
          path.join(ROOT, "frontend/public/pawns", type, name),
          "utf8",
        );
        expect(svg).not.toMatch(
          /<script|<style|<image|<use|<defs|foreignObject|\bon\w+=|\bhref=|url\s*\(/i,
        );
        expect(svg).toMatch(/^<svg [^>]*viewBox="[^"]+"[^>]*>/);
        expect(svg).toContain("<path");
      }
    }
  });
});
