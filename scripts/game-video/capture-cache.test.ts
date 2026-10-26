import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneCaptureCaches,
  readCaptureCache,
  writeCaptureCache,
} from "./capture-cache.mjs";

const INPUTS = {
  gameId: "VoSWbMDd",
  seatColors: true,
  greyStartWalls: true,
  boardTheme: "crisp",
  browser: "chromium",
  captureDpr: 3,
};

/** A capture as the renderer holds it, with real files in a work folder. */
const fixture = () => {
  const work = mkdtempSync(join(tmpdir(), "cache-work-"));
  const file = (name: string, body: string) => {
    const path = join(work, name);
    writeFileSync(path, body);
    return path;
  };
  return {
    inputs: INPUTS,
    capturedAt: "2026-10-27T11:30:00Z",
    replay: { kind: "replay", state: { history: [{ notation: "Mc4" }] } },
    cards: [{ y: 10, cardText: "Normal Bot", layers: [] }],
    accents: { 1: [32, 132, 250], 2: [234, 60, 38] },
    portraits: {
      1: file("portrait-p1.png", "p1"),
      2: file("portrait-p2.png", "p2"),
    },
    boardBox: { x: 1, y: 2, width: 505, height: 505 },
    cellRects: { count: 64, first: { x: 1 }, last: { x: 2 } },
    capture: {
      records: [
        {
          expectedPly: -1,
          committedPly: -1,
          file: file("board-0000.png", "b0"),
          sha256: "x",
        },
        {
          expectedPly: 0,
          committedPly: 0,
          file: file("board-0001.png", "b1"),
          sha256: "y",
        },
      ],
      expected: [-1, 0],
      committed: [-1, 0],
      omissions: [],
      duplicates: [],
      reordered: false,
      mismatches: [],
    },
    pawnSpots: new Map([[0, [{ x: 0.1, y: 0.2, w: 0.1, h: 0.1 }]]]),
    wallSpots: new Map([[1, [{ vertical: true, x: 0.5, y: 0.5 }]]]),
  };
};

describe("the capture cache", () => {
  test("gives back what was saved, with its own file paths", () => {
    const c = fixture();
    const dir = join(mkdtempSync(join(tmpdir(), "cache-")), "VoSWbMDd");
    writeCaptureCache(dir, c);
    const r = readCaptureCache(dir, INPUTS);
    expect(r.replay).toEqual(c.replay);
    expect(r.cards).toEqual(c.cards);
    expect(r.accents).toEqual(c.accents);
    expect(r.boardBox).toEqual(c.boardBox);
    expect(r.cellRects).toEqual(c.cellRects);
    expect(r.pawnSpots).toEqual(c.pawnSpots);
    expect(r.wallSpots).toEqual(c.wallSpots);
    expect(r.capture.omissions).toEqual([]);
    expect(r.capture.records.map((x: { file: string }) => x.file)).toEqual([
      join(dir, "board-0000.png"),
      join(dir, "board-0001.png"),
    ]);
    expect(readFileSync(r.portraits[2], "utf8")).toBe("p2");
    expect(readFileSync(r.capture.records[1].file, "utf8")).toBe("b1");
  });

  test("refuses a render whose inputs change the pixels", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cache-")), "g");
    writeCaptureCache(dir, fixture());
    expect(() =>
      readCaptureCache(dir, { ...INPUTS, boardTheme: "default" }),
    ).toThrow('made with boardTheme="crisp", and this render needs "default"');
    expect(() =>
      readCaptureCache(dir, { ...INPUTS, seatColors: false }),
    ).toThrow("seatColors");
  });

  test("refuses a changed or missing file, and a missing cache", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cache-")), "g");
    writeCaptureCache(dir, fixture());
    writeFileSync(join(dir, "board-0001.png"), "changed");
    expect(() => readCaptureCache(dir, INPUTS)).toThrow(
      "missing or changed file: board-0001.png",
    );
    expect(() => readCaptureCache(join(dir, "none"), INPUTS)).toThrow(
      "no capture cache",
    );
  });

  test("a second write replaces the first", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cache-")), "g");
    writeCaptureCache(dir, fixture());
    const c = fixture();
    writeCaptureCache(dir, { ...c, capturedAt: "2026-10-28T11:30:00Z" });
    expect(readCaptureCache(dir, INPUTS).capturedAt).toBe(
      "2026-10-28T11:30:00Z",
    );
  });

  test("pruning keeps the newest games and deletes the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-"));
    const names = ["a", "b", "c", "d"];
    names.forEach((name, i) => {
      writeCaptureCache(join(root, name), fixture());
      const t = new Date(Date.UTC(2026, 9, 20 + i));
      utimesSync(join(root, name, "capture.json"), t, t);
    });
    expect(pruneCaptureCaches(root, 2).sort()).toEqual(["a", "b"]);
    expect(names.map((n) => existsSync(join(root, n)))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});
