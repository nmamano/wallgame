import { describe, expect, test } from "bun:test";
import {
  OVERLAYS,
  OVERLAY_FORMS,
  boxOnScreen,
  coveredBy,
  loadingPercent,
  overlayPlaces,
  placeName,
  placeOverlay,
  overlayWords,
  readingSeconds,
} from "./overlays.mjs";

const cell = (x: number, y: number, size = 0.125) => ({
  x0: x,
  y0: y,
  x1: x + size,
  y1: y + size,
});

describe("overlays", () => {
  test("every asset has a form, a draw and its risks", () => {
    for (const [name, a] of Object.entries(OVERLAYS)) {
      expect([name, OVERLAY_FORMS.includes(a.form)]).toEqual([name, true]);
      expect([name, a.claim, a.likeness]).toEqual([name, "None", "None"]);
      if (a.form === "clip") expect(a.size).toBeDefined();
      // A clip's frames: a corner clip, its length its frames' length.
      if (a.draw === "sequence") {
        expect([name, a.form]).toEqual([name, "clip"]);
        expect([name, a.seconds]).toEqual([
          name,
          a.sequence!.frames / a.sequence!.fps,
        ]);
      } else {
        expect([name, a.sequence]).toEqual([name, undefined]);
      }
    }
  });

  test("every place lies inside the board", () => {
    for (const a of Object.values(OVERLAYS)) {
      for (const p of overlayPlaces(a)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(1);
        expect(p.y + p.h).toBeLessThanOrEqual(1);
      }
    }
  });

  test("a panel is a band: top, bottom, then every height; none free, null", () => {
    const panel = OVERLAYS["capture-loading"];
    expect(placeOverlay(panel, [])?.where).toBe("top");
    expect(placeOverlay(panel, [cell(0.4, 0.1)])?.where).toBe("bottom");
    // Pawns near both edges: the band between them (Nil, 2026-10-28: an
    // overlay never covers a pawn, so a half-board panel rarely fit).
    expect(placeOverlay(panel, [cell(0.4, 0.1), cell(0.1, 0.8)])?.where).toBe(
      "band 0.25",
    );
    const band = placeOverlay(panel, [cell(0.4, 0.1), cell(0.1, 0.8)])!;
    expect(band.y).toBeGreaterThanOrEqual(0.225);
    expect(band.y + band.h).toBeLessThanOrEqual(0.8);
    // A pawn on every row band: none.
    expect(
      placeOverlay(
        panel,
        [0.05, 0.3, 0.55, 0.8].map((y) => cell(0.4, y)),
      ),
    ).toBeNull();
  });

  test("the ending's bar takes the strip the ending leaves free", () => {
    const bar = OVERLAYS["ending-caption"];
    expect(placeOverlay(bar, [])?.where).toBe("top");
    // The GG card: the middle of the board.
    expect(
      placeOverlay(bar, [{ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }])?.where,
    ).toBe("top");
    expect(
      placeOverlay(bar, [{ x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.8 }])?.where,
    ).toBe("bottom");
    // The ko ending, measured 2026-10-28: its pawn on top, its banner below.
    expect(
      placeOverlay(bar, [
        { x0: 0.5, y0: 0.01, x1: 0.62, y1: 0.13 },
        { x0: -0.35, y0: 0.52, x1: 1.35, y1: 1.02 },
      ])?.where,
    ).toBe("band 0.15");
    expect(placeOverlay(bar, [{ x0: 0, y0: 0.1, x1: 1, y1: 0.9 }])).toBeNull();
  });

  test("a clip takes the first free corner, bottom right first", () => {
    const clip = OVERLAYS["chat-toast"];
    expect(placeOverlay(clip, [])?.where).toBe("bottom-right");
    expect(placeOverlay(clip, [cell(0.875, 0.875)])?.where).toBe("bottom-left");
    expect(placeOverlay(clip, [cell(0.4, 0.875)])?.where).toBe("top-right");
    expect(
      placeOverlay(clip, [cell(0.5, 0.875), cell(0.5, 0)])?.where,
    ).toBeUndefined();
  });

  test("a cut-out with a small size tries it only when no big corner is free", () => {
    const reactor = OVERLAYS["reactor-shock"];
    expect(reactor.small!.w).toBeLessThan(reactor.size!.w);
    expect(reactor.small!.h).toBeLessThan(reactor.size!.h);
    const big = placeOverlay(reactor, [])!;
    expect([big.where, big.scale, placeName(big)]).toEqual([
      "bottom-right",
      1,
      "bottom-right",
    ]);
    // A pawn just inside each big corner, outside each small one: the
    // corner itself, small, with its content scaled down with it.
    const edge = 0.025 + 0.4;
    const pawns = [
      cell(edge, edge),
      cell(1 - edge - 0.125, edge),
      cell(edge, 1 - edge - 0.125),
      cell(1 - edge - 0.125, 1 - edge - 0.125),
    ];
    const small = placeOverlay(reactor, pawns)!;
    expect(placeName(small)).toBe("bottom-right, small");
    expect(small.scale).toBeCloseTo(0.36 / 0.46);
    // A clip with no small size stops there.
    expect(placeOverlay(OVERLAYS["chat-toast"], [cell(0, 0, 1)])).toBeNull();
    // The bottom half busy too: the next small corner, in the same order.
    expect(placeName(placeOverlay(reactor, [...pawns, cell(0, 0.6, 1)])!)).toBe(
      "top-right, small",
    );
  });

  test("the reading time counts words, numbers and names, not emoji", () => {
    const toast = OVERLAYS["chat-toast"];
    expect(overlayWords(toast, "bro's heart rate rn")).toBe(4);
    expect(readingSeconds(toast, "bro's heart rate rn")).toBe(2.4);
    expect(overlayWords(toast, "{red} -> {blue} 💀 12")).toBe(5);
    expect(readingSeconds(toast, "💀 🙏")).toBe(0);
    expect(readingSeconds(toast, undefined)).toBe(0);
    // The words the stage draws count too.
    expect(readingSeconds(OVERLAYS["path-compare"], undefined)).toBe(2.7);
    expect(readingSeconds(OVERLAYS["capture-loading"], undefined)).toBe(2.1);
  });

  test("coveredBy gives the boxes a place overlaps", () => {
    const [bottomRight] = overlayPlaces(OVERLAYS["chat-toast"]);
    const far = { ...cell(0.1, 0.1), cell: "far" };
    const near = { ...cell(0.875, 0.875), cell: "near" };
    expect(coveredBy(bottomRight, [far, near])).toEqual([near]);
  });

  test("a zoom moves a box away from its point and cuts it to the board", () => {
    expect(boxOnScreen(cell(0.5, 0.5), null)).toEqual(cell(0.5, 0.5));
    expect(boxOnScreen(cell(0.5, 0.5), { scale: 2, x: 0.5, y: 0.5 })).toEqual({
      x0: 0.5,
      y0: 0.5,
      x1: 0.75,
      y1: 0.75,
    });
    expect(
      boxOnScreen(cell(0.875, 0.875), { scale: 2, x: 0, y: 0 }),
    ).toBeNull();
  });

  test("the loading bar runs 96..99% as the hunter closes in", () => {
    expect([6, 4, 3, 2, 1, 0].map(loadingPercent)).toEqual([
      96, 96, 97, 98, 99, 99,
    ]);
  });
});
