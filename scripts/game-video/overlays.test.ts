import { describe, expect, test } from "bun:test";
import {
  CARDS,
  DEATH_CARDS,
  NO_REACH,
  OVERLAYS,
  OVERLAY_FORMS,
  PLACE_KINDS,
  boxOnScreen,
  needsNilOk,
  offBoardPlace,
  placesOf,
  riskLevel,
  takesSeat,
  coveredBy,
  loadingPercent,
  overlayPlaces,
  placeName,
  placeOverlay,
  overlayWords,
  reactorRole,
  readingSeconds,
  outlineCrop,
  parsePawn,
  nearFaults,
  placeNear,
  placeAround,
  PAWN_PLACES,
  tailHits,
  tailLength,
  tailOf,
  TIP_CLEAR,
  tailPoints,
  takesPawn,
  TAIL_GAP,
} from "./overlays.mjs";

const cell = (x: number, y: number, size = 0.125) => ({
  x0: x,
  y0: y,
  x1: x + size,
  y1: y + size,
});

/** Every off-board place has room. */
const ROOM = () => null;
/** A place with no art past its box, every off-board place with room. */
const place = (
  asset: Parameters<typeof placeOverlay>[0],
  busy: Parameters<typeof placeOverlay>[1],
  offRoom: Parameters<typeof placeOverlay>[3] = ROOM,
) => placeOverlay(asset, busy, NO_REACH, offRoom);

describe("overlays", () => {
  test("every asset has a form, a draw, its places and its risks", () => {
    for (const [name, a] of Object.entries(OVERLAYS)) {
      expect([name, OVERLAY_FORMS.includes(a.form)]).toEqual([name, true]);
      // A risk is "None", or a level and why.
      for (const risk of [a.claim, a.likeness]) {
        expect([name, /^(None|(LOW|MEDIUM|HIGH)(: .+)?)$/.test(risk)]).toEqual([
          name,
          true,
        ]);
      }
      // Only a picture or a clip from the web, or a known meme's look (a
      // card, a redraw), has a risk.
      if (!["card", "image", "redraw", "sequence"].includes(a.draw)) {
        expect([name, a.claim, a.likeness]).toEqual([name, "None", "None"]);
      }
      const places = placesOf(a);
      expect([name, places.every((k) => PLACE_KINDS.includes(k))]).toEqual([
        name,
        true,
      ]);
      expect([name, new Set(places).size]).toEqual([name, places.length]);
      // The margin takes the shape of a size; a bar has none.
      if (places.includes("margin")) expect(a.size).toBeDefined();
      expect([name, a.draw === "card"]).toEqual([
        name,
        CARDS.includes(a.card ?? ""),
      ]);
      if (a.draw === "image") {
        expect(a.image!.sha256).toMatch(/^[0-9a-f]{64}$/);
        const c = a.image!.crop;
        expect(c.x + c.w).toBeLessThanOrEqual(1);
        expect(c.y + c.h).toBeLessThanOrEqual(1);
        // A picture's box and its crop have about the same shape (the
        // board is square), so it fills its place.
        const [w, h] = a.image!.pixels;
        expect(a.size!.w / a.size!.h / ((c.w * w) / (c.h * h))).toBeCloseTo(
          1,
          1,
        );
      } else {
        expect([name, a.image]).toEqual([name, undefined]);
      }
      if (a.form === "clip") expect(a.size).toBeDefined();
      // A clip's frames: a corner clip or a cover, its length its frames'
      // length (to the ms prepare-overlay-clip.mjs prints).
      if (a.draw === "sequence") {
        expect([name, ["clip", "cover"].includes(a.form)]).toEqual([
          name,
          true,
        ]);
        expect(a.seconds!).toBeCloseTo(a.sequence!.frames / a.sequence!.fps, 3);
      } else {
        expect([name, a.sequence]).toEqual([name, undefined]);
      }
      // Only a clip covers the board: the pawn test reads its pixels.
      if (a.form === "cover")
        expect([name, a.draw]).toEqual([name, "sequence"]);
    }
  });

  test("every place lies inside the board", () => {
    for (const a of Object.values(OVERLAYS)) {
      for (const p of overlayPlaces(a, NO_REACH)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(1);
        expect(p.y + p.h).toBeLessThanOrEqual(1);
      }
    }
  });

  test("a panel is a band: top, bottom, then every height; none free, null", () => {
    const panel = OVERLAYS["capture-loading"];
    expect(place(panel, [])?.where).toBe("top");
    expect(place(panel, [cell(0.4, 0.1)])?.where).toBe("bottom");
    // Pawns near both edges: the band between them (Nil, 2026-10-28: an
    // overlay never covers a pawn, so a half-board panel rarely fit).
    expect(place(panel, [cell(0.4, 0.1), cell(0.1, 0.8)])?.where).toBe(
      "band 0.25",
    );
    // A panel never takes the bar's caption place: a board place.
    const band = place(panel, [cell(0.4, 0.1), cell(0.1, 0.8)]) as ReturnType<
      typeof overlayPlaces
    >[number];
    expect(band.y).toBeGreaterThanOrEqual(0.225);
    expect(band.y + band.h).toBeLessThanOrEqual(0.8);
    // A pawn on every row band: none.
    expect(
      place(
        panel,
        [0.05, 0.3, 0.55, 0.8].map((y) => cell(0.4, y)),
      ),
    ).toBeNull();
  });

  test("the ending's bar takes the strip the ending leaves free", () => {
    const bar = OVERLAYS["ending-caption"];
    expect(place(bar, [])?.where).toBe("top");
    // The GG card: the middle of the board.
    expect(place(bar, [{ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }])?.where).toBe(
      "top",
    );
    expect(place(bar, [{ x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.8 }])?.where).toBe(
      "bottom",
    );
    // The ko ending, measured 2026-10-28: its pawn on top, its banner below.
    expect(
      place(bar, [
        { x0: 0.5, y0: 0.01, x1: 0.62, y1: 0.13 },
        { x0: -0.35, y0: 0.52, x1: 1.35, y1: 1.02 },
      ])?.where,
    ).toBe("band 0.15");
    // No board place free: the caption's place, over the frame (Wall Game
    // Director, 2026-10-30), at the board bar's size.
    const { x, w, h } = place(bar, [])!;
    const full = [{ x0: 0, y0: 0.1, x1: 1, y1: 0.9 }];
    expect(place(bar, full)).toEqual({
      where: "caption",
      x,
      w,
      h,
      scale: 1,
      full: null,
    });
    // ... when it has room there (a look with no caption line has none).
    expect(place(bar, full, () => "no caption line")).toBeNull();
  });

  test("an asset takes its places in its order, off the board with room", () => {
    const pawnsEverywhere = [{ x0: 0, y0: 0, x1: 1, y1: 1 }];
    // The time card: the caption's place first, then the board.
    const later = OVERLAYS["eternity-later"];
    expect(place(later, [])?.where).toBe("caption");
    expect(place(later, [], () => "no room")?.where).toBe("top");
    expect(place(later, pawnsEverywhere, () => "no room")).toBeNull();
    // The reverse card and the pictures: a board corner first (Wall Game
    // Director, 2026-10-30: in the margin they are too small to read on a
    // phone), the left margin when no corner is free.
    const uno = OVERLAYS["uno-reverse"];
    expect(place(uno, [])?.where).toBe("bottom-right");
    expect(place(uno, pawnsEverywhere)).toEqual({
      where: "margin",
      x: 0,
      w: uno.size!.w,
      h: uno.size!.h,
      scale: 1,
      full: null,
    });
    expect(place(uno, [], () => "too narrow")?.where).toBe("bottom-right");
    // A board place still never covers a pawn.
    expect(place(uno, pawnsEverywhere, () => "too narrow")).toBeNull();
    // The death screens: a band on the board, then the caption's place.
    const wasted = OVERLAYS.wasted;
    expect(place(wasted, [])?.where).toBe("top");
    expect(place(wasted, pawnsEverywhere)?.where).toBe("caption");
    // An asset with no off-board place never asks for one.
    const asked: string[] = [];
    place(OVERLAYS["chat-toast"], pawnsEverywhere, (k) => {
      asked.push(k);
      return null;
    });
    expect(asked).toEqual([]);
    expect(offBoardPlace(wasted, "caption")).toEqual(
      offBoardPlace(OVERLAYS["ending-caption"], "caption"),
    );
  });

  test("a MEDIUM or HIGH asset needs Nil's OK for a daily video", () => {
    expect(riskLevel("None")).toBe("None");
    expect(riskLevel("MEDIUM: a TV frame")).toBe("MEDIUM");
    expect(needsNilOk(OVERLAYS["the-scream"])).toBe(false);
    expect(needsNilOk(OVERLAYS["smudge-cat"])).toBe(true);
    expect(needsNilOk(OVERLAYS["monkey-puppet"])).toBe(true);
    expect(
      needsNilOk({ ...OVERLAYS["monkey-puppet"], nilOk: "2026-10-31" }),
    ).toBe(false);
    expect(needsNilOk({ claim: "None", likeness: "HIGH: a real person" })).toBe(
      true,
    );
    for (const name of CARDS) expect(needsNilOk(OVERLAYS[name])).toBe(false);
  });

  test("the reverse card, the reactors and the pointing pawns name their seat; nothing else", () => {
    expect(
      Object.entries(OVERLAYS)
        .filter(([, a]) => takesSeat(a))
        .map(([n]) => n),
    ).toEqual([
      "reactor-shock",
      "reactor-laugh",
      "reactor-stare",
      "do-something",
      "uno-reverse",
      "pointing-pawns",
    ]);
  });

  test("a clip takes the first free corner, bottom right first", () => {
    const clip = OVERLAYS["chat-toast"];
    expect(place(clip, [])?.where).toBe("bottom-right");
    expect(place(clip, [cell(0.875, 0.875)])?.where).toBe("bottom-left");
    expect(place(clip, [cell(0.4, 0.875)])?.where).toBe("top-right");
    expect(
      place(clip, [cell(0.5, 0.875), cell(0.5, 0)])?.where,
    ).toBeUndefined();
  });

  test("a cut-out with a small size tries it only when no big corner is free", () => {
    const reactor = OVERLAYS["reactor-shock"];
    expect(reactor.small!.w).toBeLessThan(reactor.size!.w);
    expect(reactor.small!.h).toBeLessThan(reactor.size!.h);
    const big = place(reactor, [])!;
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
    const small = place(reactor, pawns)!;
    expect(placeName(small)).toBe("bottom-right, small");
    expect(small.scale).toBeCloseTo(0.36 / 0.46);
    // A clip with no small size stops there.
    expect(place(OVERLAYS["chat-toast"], [cell(0, 0, 1)])).toBeNull();
    // The bottom half busy too: the next small corner, in the same order.
    expect(placeName(place(reactor, [...pawns, cell(0, 0.6, 1)])!)).toBe(
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
    const [bottomRight] = overlayPlaces(OVERLAYS["chat-toast"], NO_REACH);
    const far = { ...cell(0.1, 0.1), cell: "far" };
    const near = { ...cell(0.875, 0.875), cell: "near" };
    expect(coveredBy(bottomRight, [far, near])).toEqual([near]);
  });

  test("a corner keeps its whole art inside the board", () => {
    // The shock reactor's punch-in and 💦 reach past the top of its box
    // (VX ply 14, 2026-10-29).
    const reactor = OVERLAYS["reactor-shock"];
    const reach = () => ({ top: 0.2, right: 0.1, bottom: 0, left: 0.05 });
    for (const p of overlayPlaces(reactor, reach)) {
      expect(p.full.x).toBeGreaterThanOrEqual(0.025 - 1e-9);
      expect(p.full.y).toBeGreaterThanOrEqual(0.025 - 1e-9);
      expect(p.full.x + p.full.w).toBeLessThanOrEqual(0.975 + 1e-9);
      expect(p.full.y + p.full.h).toBeLessThanOrEqual(0.975 + 1e-9);
      expect(p.full.y).toBeCloseTo(p.y - 0.2 * p.h, 9);
    }
    const top = overlayPlaces(reactor, reach).find(
      (p) => p.where === "top-right",
    )!;
    expect(top.y).toBeCloseTo(0.025 + 0.2 * 0.42, 9);
  });

  test("a place is refused for a pawn under its art, not only its box", () => {
    const reactor = OVERLAYS["reactor-shock"];
    const reach = () => ({ top: 0.3, right: 0, bottom: 0, left: 0 });
    // Just above the bottom-right box, under its art's reach.
    const box = overlayPlaces(reactor, reach)[0];
    const pawn = cell(0.8, box.y - 0.1, 0.05);
    expect(placeOverlay(reactor, [pawn], NO_REACH, ROOM)?.where).toBe(
      "bottom-right",
    );
    expect(placeOverlay(reactor, [pawn], reach, ROOM)?.where).toBe(
      "bottom-left",
    );
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

describe("the pawn a reactor shows (Nil, 2026-10-29: cats are pursuers)", () => {
  test("a shock is the threatened side's prey", () => {
    expect(reactorRole(OVERLAYS["reactor-shock"])).toBe("prey");
  });
  test("a laugh is the prey of the side that profits", () => {
    expect(reactorRole(OVERLAYS["reactor-laugh"])).toBe("prey");
  });
  test("a stare is the hunting seat's cat", () => {
    expect(reactorRole(OVERLAYS["reactor-stare"])).toBe("hunter");
    expect(reactorRole(OVERLAYS["do-something"])).toBe("hunter");
  });
  test("every reactor asset has a role, and nothing else has one", () => {
    for (const asset of Object.values(OVERLAYS)) {
      if (asset.draw === "reactor") {
        expect(["prey", "hunter"]).toContain(reactorRole(asset));
      } else {
        expect(() => reactorRole(asset)).toThrow("no reactor role");
      }
    }
  });
});

describe("a picture a pawn emotes (Nil, 2026-10-30, C20)", () => {
  test("a cage goes round its pawn: its window on the pawn's cell (around)", () => {
    const cages = Object.entries(OVERLAYS).filter(([, a]) => a.around);
    expect(cages.map(([k]) => k)).toEqual(["gs-jail-bars"]);
    for (const [, a] of cages) {
      // A clip a pawn emotes, drawn from its frames, with no tail.
      expect(a).toMatchObject({
        form: "clip",
        draw: "sequence",
        pawn: true,
        tail: false,
      });
      const { window: win, cells } = a.around!;
      expect(0 <= win.x0 && win.x0 < win.x1 && win.x1 <= 1).toBe(true);
      expect(0 <= win.y0 && win.y0 < win.y1 && win.y1 <= 1).toBe(true);
      // Wider than a cell, so the walls on the pawn's cell edges show.
      expect(cells).toBeGreaterThan(1);
    }
    const cage = { around: OVERLAYS["gs-jail-bars"].around! };
    const { window: win, cells } = cage.around;
    const pitch = { x: 1 / 8, y: 1 / 8 };
    const p = placeAround(cage, { x: 0.5625, y: 0.3125 }, pitch);
    expect(p).toMatchObject({
      where: "around",
      scale: 1,
      tail: null,
      over: [],
    });
    expect(p.full).toEqual({ x: p.x, y: p.y, w: p.w, h: p.h });
    // Its window is centred on the pawn, `cells` cells wide and high.
    expect(p.x + ((win.x0 + win.x1) / 2) * p.w).toBeCloseTo(0.5625, 9);
    expect(p.y + ((win.y0 + win.y1) / 2) * p.h).toBeCloseTo(0.3125, 9);
    expect((win.x1 - win.x0) * p.w).toBeCloseTo(cells / 8, 9);
    expect((win.y1 - win.y0) * p.h).toBeCloseTo(cells / 8, 9);
    // A pawn in a corner: the cage passes the board's edge, which cuts it.
    const corner = placeAround(cage, { x: 1 / 16, y: 15 / 16 }, pitch);
    expect(corner.x).toBeLessThan(0);
    expect(corner.y + corner.h).toBeGreaterThan(1);
  });

  const PITCH = { x: 0.125, y: 0.125 };
  // The-scream's shape, with the tail a picture has unless it says
  // `tail: false` (the-scream itself has none since C45).
  const scream = { ...OVERLAYS["the-scream"], tail: undefined };
  /** A busy box, named as the render names one. */
  const busyCell = (x: number, y: number, size?: number) => ({
    ...cell(x, y, size),
    what: "a wall",
  });
  const near = (
    pawn: { x: number; y: number },
    busy: Parameters<typeof placeNear>[1] = [],
    others: Parameters<typeof placeNear>[4] = [],
    walls: { x0: number; y0: number; x1: number; y1: number }[] = [],
    place?: string,
  ) =>
    placeNear(
      scream as Parameters<typeof placeNear>[0],
      // The pawn's own box is busy, as in the render (pawnBoxes).
      [
        ...busy,
        {
          ...cell(pawn.x - PITCH.x / 2, pawn.y - PITCH.y / 2),
          what: "the pawn",
        },
      ],
      NO_REACH,
      pawn,
      others,
      PITCH,
      { walls, place },
    );

  test("the pictures and redraws take a pawn, on the board only", () => {
    const tied = Object.entries(OVERLAYS)
      .filter(([, a]) => takesPawn(a))
      .map(([k]) => k);
    expect(tied).toEqual([
      "resign-flag",
      "the-scream",
      "smudge-cat",
      "monkey-puppet",
      "great-wave",
      "wanderer",
      "medusa",
      "saturn",
      "surprised-mouse",
      "this-is-fine-mouse",
      "scream-mouse",
      "gs-siren",
      "gs-jail-bars",
      "stupid-stamp",
      "gs-jjj-laugh",
      "gs-laugh-cry",
      "gs-hands-on-head",
      "gs-squidward-bm",
      "gs-confused-travolta",
      "gs-terio-ooh",
      "gs-crying-man",
    ]);
    for (const k of tied)
      expect([k, placesOf(OVERLAYS[k])]).toEqual([k, ["board"]]);
    expect(parsePawn("red mouse")).toEqual({ seat: "red", piece: "mouse" });
    expect(parsePawn("blue cat")).toEqual({ seat: "blue", piece: "cat" });
    for (const bad of ["red", "red  mouse", "Red mouse", "red rat", 3]) {
      expect(parsePawn(bad)).toBeNull();
    }
  });

  test("the scream is cut in its outline, its crop the outline's box", () => {
    const img = scream.image!;
    expect(img.outline!.length).toBeGreaterThan(8);
    expect(img.crop).toEqual(outlineCrop(img.outline!, img.pixels));
    expect(
      outlineCrop(
        [
          [10, 20],
          [30, 60],
          [20, 40],
        ],
        [100, 200],
      ),
    ).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2,
    });
  });

  test("goes to the free place with the shortest tail, corners and edge middles", () => {
    // The top-left corner covers this pawn: the top middle is nearest.
    expect(near({ x: 0.2, y: 0.35 })?.where).toBe("top-middle");
    // A pawn in the bottom-right corner: the right middle, above it.
    expect(near({ x: 0.9375, y: 0.9375 })?.where).toBe("right-middle");
    // The top middle taken at both sizes: the bottom-left corner (tail
    // 1.1 cells), big before small.
    const p = near({ x: 0.2, y: 0.35 }, [busyCell(0.45, 0.05, 0.05)]);
    expect([p?.where, p?.scale]).toEqual(["bottom-left", 1]);
  });

  test("with tail: false, the nearest free place and no tail (Nil, 2026-11-01, C45)", () => {
    const pawn = { x: 0.2, y: 0.35 };
    const noTail = placeNear(
      { ...scream, tail: false } as Parameters<typeof placeNear>[0],
      [
        {
          ...cell(pawn.x - PITCH.x / 2, pawn.y - PITCH.y / 2),
          what: "the pawn",
        },
      ],
      NO_REACH,
      pawn,
      [],
      PITCH,
    );
    expect(noTail?.where).toBe(near(pawn)?.where);
    expect(noTail?.tail).toBeNull();
    // Every green-screen cut-out stands beside its pawn with no pointer.
    const gs = Object.entries(OVERLAYS).filter(
      ([k, a]) => k.startsWith("gs-") && takesPawn(a),
    );
    expect(gs.length).toBeGreaterThan(0);
    for (const [, asset] of gs) expect(asset).toMatchObject({ tail: false });
    // So does the resign flag: its words name the side.
    expect(OVERLAYS["resign-flag"]).toMatchObject({ tail: false });
  });

  test("the EDL's place is the only one tried, under the same faults", () => {
    const names = overlayPlaces(
      scream as Parameters<typeof placeNear>[0],
      NO_REACH,
      { middles: true },
    ).map((p) => p.where);
    expect([...new Set(names)].sort()).toEqual([...PAWN_PLACES].sort());
    // Its nearest place is the top middle; the director asks for another.
    const pawn = { x: 0.2, y: 0.35 };
    expect(near(pawn)?.where).toBe("top-middle");
    expect(near(pawn, [], [], [], "bottom-right")).toMatchObject({
      where: "bottom-right",
      scale: 1,
    });
    // The asked place taken at both sizes: no other place stands in.
    expect(
      near(pawn, [busyCell(0.45, 0.05, 0.05)], [], [], "top-middle"),
    ).toBeNull();
  });

  test("a small place near the pawn before a big place far from it (review 102 N2)", () => {
    const pawn = { x: 0.3, y: 0.6 };
    const all = overlayPlaces(
      scream as Parameters<typeof placeNear>[0],
      NO_REACH,
      { middles: true },
    );
    const length = (where: string, scale: number) =>
      tailLength(
        tailOf(
          all.find((q) => q.where === where && q.scale === scale)!.full,
          pawn,
          PITCH,
        ),
        PITCH,
      );
    // The small left middle (0.07 cell) before the big bottom middle (0.17).
    expect(length("left-middle", 0.8)).toBeLessThan(length("bottom-middle", 1));
    expect(near(pawn)).toMatchObject({ where: "left-middle", scale: 0.8 });
  });

  // A pawn whose nearest place, the top middle, has a tail 0.82 cell long.
  const pawn = { x: 0.8, y: 0.3 };

  test("a place whose tip ends next to another pawn is not taken (review 102 N2)", () => {
    const first = near(pawn)!;
    expect(first.where).toBe("top-middle");
    const tip = first.tail!.to;
    // Another pawn under TIP_CLEAR cells from the tip, on its far side
    // from the pawn (the tail comes from the left).
    expect(tip.x).toBeLessThan(pawn.x);
    const other = {
      x: tip.x - 0.9 * TIP_CLEAR * PITCH.x,
      y: tip.y,
      what: "pawn on f4",
    };
    expect(nearFaults(first, first.tail, [], [other], PITCH)).toEqual([
      "its tip is next to the pawn on f4",
    ]);
    const next = near(pawn, [], [other])!;
    expect(next.where === first.where && next.scale === first.scale).toBe(
      false,
    );
    // Just past TIP_CLEAR: the tip points at its own pawn only.
    const clear = { ...other, x: tip.x - 1.01 * TIP_CLEAR * PITCH.x };
    expect(near(pawn, [], [clear])).toMatchObject({
      where: first.where,
      scale: first.scale,
    });
  });

  test("a place that covers no wall comes before a nearer one that covers a wall (Wall Game Director, 2026-10-30)", () => {
    expect([near(pawn)?.where, near(pawn)?.scale]).toEqual(["top-middle", 1]);
    // An old wall under the big top middle only, not under the small one.
    const wall = { x0: 0.38, y0: 0.38, x1: 0.39, y1: 0.42 };
    expect(near(pawn, [], [], [wall])).toMatchObject({
      where: "top-middle",
      scale: 0.8,
    });
    // An old wall under the big top middle's tail only (not its art):
    // that place comes last too (Director Rewriter, 2026-10-30: saturn's
    // tip lay on an old wall).
    const first = near(pawn)!;
    const { from, to } = first.tail!;
    const mid = {
      x: from.x + (to.x - from.x) * 0.6,
      y: from.y + (to.y - from.y) * 0.6,
    };
    const underTail = {
      x0: mid.x - 0.005,
      y0: mid.y - 0.005,
      x1: mid.x + 0.005,
      y1: mid.y + 0.005,
    };
    expect(coveredBy(first.full, [underTail])).toEqual([]);
    const moved = near(pawn, [], [], [underTail])!;
    expect(moved.where === first.where && moved.scale === first.scale).toBe(
      false,
    );
    // A wall under every place: the shortest tail again.
    const everywhere = { x0: 0, y0: 0, x1: 1, y1: 1 };
    expect(near(pawn, [], [], [everywhere])).toMatchObject({
      where: "top-middle",
      scale: 1,
    });
  });

  test("its tail points at the pawn and stops short of it", () => {
    const p = near(pawn)!;
    const t = p.tail!;
    // It starts inside the picture's box, near its edge, and leaves it.
    const inBox = (q: { x: number; y: number }) =>
      q.x > p.full.x &&
      q.x < p.full.x + p.full.w &&
      q.y > p.full.y &&
      q.y < p.full.y + p.full.h;
    expect(inBox(t.from)).toBe(true);
    expect(inBox(t.to)).toBe(false);
    const gap = Math.hypot(
      (pawn.x - t.to.x) / PITCH.x,
      (pawn.y - t.to.y) / PITCH.y,
    );
    expect(gap).toBeCloseTo(TAIL_GAP, 6);
    // On the line from the picture to the pawn.
    const cross =
      (t.to.x - t.from.x) * (pawn.y - t.from.y) -
      (t.to.y - t.from.y) * (pawn.x - t.from.x);
    expect(cross).toBeCloseTo(0, 9);
    // A wedge: two base points either side of its start, then its tip.
    const [a, tip, b] = tailPoints(t, PITCH);
    expect(tip).toEqual([t.to.x, t.to.y]);
    expect((a[0] + b[0]) / 2).toBeCloseTo(t.from.x, 9);
    expect((a[1] + b[1]) / 2).toBeCloseTo(t.from.y, 9);
    // Too near for a tail: none.
    expect(
      tailOf({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5 }, PITCH),
    ).toBeNull();
  });

  /** A box on `p`'s tail, three quarters of the way to its tip. */
  const onTail = (
    p: NonNullable<ReturnType<typeof near>>,
    what: string,
    wall = false,
  ) => {
    const t = p.tail!;
    const mid = {
      x: (t.from.x + t.to.x * 3) / 4,
      y: (t.from.y + t.to.y * 3) / 4,
    };
    return {
      x0: mid.x - 0.01,
      y0: mid.y - 0.01,
      x1: mid.x + 0.01,
      y1: mid.y + 0.01,
      what,
      ...(wall ? { wall: true } : {}),
    };
  };

  test("a place whose tail would cross a pawn is not taken", () => {
    const first = near(pawn)!;
    const block = onTail(first, "a pawn");
    expect(tailHits(first.tail!, first.full, [block], PITCH)).toEqual([block]);
    const other = near(pawn, [block])!;
    expect(other.where === first.where && other.scale === first.scale).toBe(
      false,
    );
    expect(tailHits(other.tail!, other.full, [block], PITCH)).toEqual([]);
    expect(other.over).toEqual([]);
  });

  test("a tail crosses a wall of the move only when no place has a clear tail, and names it to draw over", () => {
    const first = near(pawn)!;
    const all = overlayPlaces(
      scream as Parameters<typeof placeNear>[0],
      NO_REACH,
      { middles: true },
    );
    // Every other place taken: a dot at its middle, off the first's art.
    const taken = all
      .filter((q) => !(q.where === first.where))
      .map((q) => ({
        x0: q.full.x + q.full.w / 2 - 0.005,
        y0: q.full.y + q.full.h / 2 - 0.005,
        x1: q.full.x + q.full.w / 2 + 0.005,
        y1: q.full.y + q.full.h / 2 + 0.005,
        what: "a cell in play",
      }))
      .filter(
        (b) =>
          !(
            b.x1 > first.full.x &&
            b.x0 < first.full.x + first.full.w &&
            b.y1 > first.full.y &&
            b.y0 < first.full.y + first.full.h
          ),
      );
    const wall = onTail(first, "a new wall", true);
    // The same corner is free while its tail is clear.
    expect(near(pawn, taken)?.where).toBe(first.where);
    // A wall of the move on every free tail: it crosses it, under the wall.
    const crossed = near(pawn, [...taken, wall])!;
    expect(crossed.where).toBe(first.where);
    expect(crossed.over).toEqual([
      { x0: wall.x0, y0: wall.y0, x1: wall.x1, y1: wall.y1 },
    ]);
    // A pawn there, not a wall: no place.
    expect(near(pawn, [...taken, onTail(first, "a pawn")])).toBeNull();
    // With a clear tail elsewhere, never a crossing.
    expect(near(pawn, [wall])?.over).toEqual([]);
  });
});

describe("the death cards (Wall Game Director, 2026-10-30)", () => {
  test("are the wasted, you-died and resign cards, each an asset the stage draws", () => {
    expect(DEATH_CARDS).toEqual(["wasted", "you-died", "resign-flag"]);
    for (const card of DEATH_CARDS) {
      expect(CARDS).toContain(card);
      expect(OVERLAYS[card]).toMatchObject({ draw: "card", card });
    }
  });
});
