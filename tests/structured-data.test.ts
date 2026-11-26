/**
 * Board 456de365: the BreadcrumbList on a puzzle page.
 *
 * No database: the puzzle list is passed in, which is also how the
 * database-fault case is reached. tests/integration/puzzle-votes.test.ts runs
 * the same lookup against a real table.
 */

import { describe, it, expect, spyOn } from "bun:test";
import {
  puzzleBreadcrumbList,
  serializeJsonLd,
  structuredDataForPath,
} from "../server/routes/structured-data";
import type { SavedPuzzleRef } from "../shared/domain/puzzle-links";

const PUZZLES: SavedPuzzleRef[] = [
  { id: "rowid-one", displayName: "Puzzle 1" },
  { id: "rowid-seven", displayName: "Puzzle 7" },
  { id: "rowid-unnumbered", displayName: "Corner trap" },
];

const load = () => Promise.resolve(PUZZLES);

describe("puzzleBreadcrumbList", () => {
  it("is Wall Game > Puzzles > the puzzle, with absolute URLs", () => {
    expect(puzzleBreadcrumbList(PUZZLES[1])).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Wall Game",
          item: "https://wallgame.io/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Puzzles",
          item: "https://wallgame.io/puzzles",
        },
        {
          "@type": "ListItem",
          position: 3,
          name: "Puzzle 7",
          item: "https://wallgame.io/puzzles/7",
        },
      ],
    });
  });

  it("links a puzzle with no number by its row id, as the app does", () => {
    const last = puzzleBreadcrumbList(PUZZLES[2]).itemListElement[2];
    expect(last.item).toBe("https://wallgame.io/puzzles/rowid-unnumbered");
  });
});

describe("serializeJsonLd", () => {
  it("cannot close its script element, and still means the same JSON", () => {
    const hostile = { name: "</script><script>alert(1)</script><!--" };

    const json = serializeJsonLd(hostile);

    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual(hostile);
  });
});

describe("structuredDataForPath", () => {
  it("describes a puzzle page by number", async () => {
    const json = await structuredDataForPath("/puzzles/7", load);
    expect(JSON.parse(json!)).toEqual(puzzleBreadcrumbList(PUZZLES[1]));
  });

  it("treats a trailing slash as the same page", async () => {
    expect(await structuredDataForPath("/puzzles/7/", load)).toBe(
      await structuredDataForPath("/puzzles/7", load),
    );
  });

  it("names the numbered address when the link uses the row id", async () => {
    const json = await structuredDataForPath("/puzzles/rowid-seven", load);
    const parsed = JSON.parse(json!) as ReturnType<typeof puzzleBreadcrumbList>;
    expect(parsed.itemListElement[2].item).toBe(
      "https://wallgame.io/puzzles/7",
    );
  });

  it("gives nothing for a puzzle that is not in the enabled list", async () => {
    for (const path of ["/puzzles/8", "/puzzles/no-such-row"]) {
      expect(await structuredDataForPath(path, load)).toBeUndefined();
    }
  });

  it("gives nothing, and never queries, on every other page", async () => {
    let queries = 0;
    const counting = () => {
      queries += 1;
      return load();
    };

    for (const path of [
      "/",
      "/play",
      "/puzzles",
      "/puzzles/",
      "/puzzles/7/extra",
      "/puzzle/game/abc123/4",
      "/solo-campaign/1",
      "/game/abc123",
    ]) {
      expect(await structuredDataForPath(path, counting)).toBeUndefined();
    }
    expect(queries).toBe(0);
  });

  it("fails open: a database fault costs the markup, not the page", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const json = await structuredDataForPath("/puzzles/7", () =>
        Promise.reject(new Error("connection refused")),
      );
      expect(json).toBeUndefined();
      expect(quiet).toHaveBeenCalledTimes(1);
    } finally {
      quiet.mockRestore();
    }
  });
});
