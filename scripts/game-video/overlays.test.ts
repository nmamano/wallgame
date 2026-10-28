import { describe, expect, test } from "bun:test";
import {
  OVERLAYS,
  OVERLAY_FORMS,
  boxOnScreen,
  coveredBy,
  loadingPercent,
  overlayPlaces,
  placeOverlay,
  quietestPlace,
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

  test("a panel takes the first free half; none free, null", () => {
    const panel = OVERLAYS["do-something"];
    expect(placeOverlay(panel, [])?.where).toBe("top");
    expect(placeOverlay(panel, [cell(0.4, 0.1)])?.where).toBe("bottom");
    expect(placeOverlay(panel, [cell(0.4, 0.1), cell(0.1, 0.8)])).toBeNull();
    // A cell that only touches the line between the halves blocks neither.
    expect(placeOverlay(panel, [cell(0.4, 0.375)])?.where).toBe("bottom");
  });

  test("a fast-forward's panel takes the half that hides the least", () => {
    const panel = OVERLAYS["do-something"];
    expect(quietestPlace(panel, []).where).toBe("top");
    const busy = [cell(0.1, 0.1), cell(0.4, 0.1), cell(0.4, 0.8)];
    expect(quietestPlace(panel, busy).where).toBe("bottom");
    expect(quietestPlace(panel, busy.slice(1)).where).toBe("top");
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

  test("a clip keeps off still pawns where a free corner allows it", () => {
    const clip = OVERLAYS["chat-toast"];
    const mouse = cell(0.875, 0.875);
    // A still pawn moves the clip to the next free corner.
    expect(placeOverlay(clip, [], [mouse])?.where).toBe("bottom-left");
    // In play stays hard: the corner with fewer still pawns is taken only
    // when it is free of what is in play.
    expect(
      placeOverlay(clip, [cell(0.0, 0.875)], [mouse, cell(0.875, 0)])?.where,
    ).toBe("top-left");
    // A still pawn in every free corner: the fewest, never a stop.
    const everywhere = [
      mouse,
      cell(0, 0.875),
      cell(0, 0.875),
      cell(0.875, 0),
      cell(0, 0),
    ];
    expect(placeOverlay(clip, [], everywhere)?.where).toBe("bottom-right");
    expect(placeOverlay(clip, [], [...everywhere, mouse, mouse])?.where).toBe(
      "top-right",
    );
    // Still pawns never make a free corner busy.
    expect(
      placeOverlay(clip, [cell(0.5, 0.875), cell(0.5, 0)], everywhere),
    ).toBeNull();
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
