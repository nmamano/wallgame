import { describe, expect, test } from "bun:test";
import { EVENT_KINDS } from "./edl.mjs";
import { fileUrlsIn, isRestShot, partsOf } from "./shoot-workers.mjs";

describe("partsOf", () => {
  test("covers every image once, in order, in nearly equal parts", () => {
    const parts = partsOf(845, 4);
    expect(parts).toEqual([
      [0, 211],
      [211, 423],
      [423, 634],
      [634, 845],
    ]);
  });

  test("starts a part only where it may, never inside an effect", () => {
    // Rest images every 10th image, and a long effect over 15..44.
    const rest = (i: number) => i % 10 === 0 && (i < 15 || i > 44);
    expect(partsOf(100, 4, rest)).toEqual([
      [0, 50],
      [50, 60],
      [60, 80],
      [80, 100],
    ]);
    // No rest image after the first: one part.
    expect(partsOf(30, 4, (i) => i === 0)).toEqual([[0, 30]]);
  });

  test("never makes an empty part", () => {
    expect(partsOf(3, 8)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(partsOf(5, 1)).toEqual([[0, 5]]);
  });
});

describe("fileUrlsIn", () => {
  test("finds file URLs at any depth, once each", () => {
    const top = { portrait: "file:///k/p1.png", hex: "rgb(1,2,3)" };
    const states = [
      { board: "file:///k/board-1.png", top, bottom: top },
      { ending: { before: "file:///k/board-1.png", winner: top } },
      { segment: "vs", a: top, list: ["file:///k/x.png", 3, null] },
    ];
    expect(fileUrlsIn(states)).toEqual([
      "file:///k/board-1.png",
      "file:///k/p1.png",
      "file:///k/x.png",
    ]);
  });
});

describe("isRestShot: no part starts inside any effect", () => {
  // The plain state of a board, as playState builds it.
  const plain = {
    segment: "play",
    look: "wallz",
    caption: "bot thinks it's winning",
    board: "file:///k/board-0034.png",
    race: { a: { n: 4 }, b: { n: 6 }, t: 0.3 },
    goal: "HOME",
    fastForward: null,
  };
  const move = { kind: "move", state: plain };
  const cell = {
    cellFx: { kind: "brilliant", t: 0.2, cell: { x: 0.4, y: 0.5 } },
  };
  /*
    Each EDL event kind: the images it plays, as the renderer labels them and
    with the fields it adds to the plain state (render-game-video.mjs:
    playFreeze, playLeadZoom, playEvents, momentState). "sound" plays no
    image of its own.
  */
  const EFFECT_IMAGES: Record<string, { kind: string; state: object }[]> = {
    zoom: [
      {
        kind: "swing-zoom",
        state: { ...plain, zoom: { scale: 1, x: 0.4, y: 0.5 } },
      },
      {
        kind: "lead-zoom",
        state: {
          ...plain,
          zoom: { scale: 1.2, x: 0.4, y: 0.5 },
          fastForward: null,
        },
      },
    ],
    scared: [
      {
        kind: "beat-scared",
        state: { ...plain, beat: { kind: "scared", t: 0.4 } },
      },
    ],
    laugh: [
      {
        kind: "beat-laugh",
        state: { ...plain, beat: { kind: "laugh", t: 0.4 } },
      },
    ],
    // Before its word lands a stamp adds nothing: only the label tells.
    stamp: [
      { kind: "beat-stamp", state: plain },
      {
        kind: "beat-stamp",
        state: { ...plain, midStamp: { text: "GG", t: 0.1, seconds: 1 } },
      },
    ],
    sound: [],
    blunder: [
      {
        kind: "beat-blunder",
        state: { ...plain, ...cell, flash: 0.4, shake: 0.2, shakePhase: 3 },
      },
    ],
    brilliant: [{ kind: "beat-brilliant", state: { ...plain, ...cell } }],
    trap: [
      {
        kind: "beat-trap",
        state: { ...plain, trap: { t: 0.2, walls: [] }, midStamp: null },
      },
    ],
    race: [
      {
        kind: "beat-race",
        state: { ...plain, race: { ...plain.race, flash: 0.2 } },
      },
    ],
    freeze: [
      {
        kind: "freeze",
        state: {
          ...plain,
          zoom: { scale: 1.3, x: 0.4, y: 0.5 },
          freeze: { t: 0.1 },
        },
      },
    ],
    react: [{ kind: "beat-react", state: { ...plain, ...cell } }],
  };
  // The images that are not EDL events.
  const OTHER_IMAGES: Record<string, { kind: string; state: object }> = {
    "VS banner": {
      kind: "vs-overlay",
      state: { ...plain, vsOverlay: { t: 1.2 } },
    },
    "VS screen": { kind: "vs-transition", state: { segment: "vs", t: 0.5 } },
    "cold open": {
      kind: "cold-open",
      state: { ...plain, zoom: { scale: 1.4, x: 0.5, y: 0.5 } },
    },
    "race tick": {
      kind: "race-tick",
      state: { ...plain, race: { ...plain.race, t: 0.1 } },
    },
    "ending replay": {
      kind: "replay",
      state: { ...plain, ending: { kind: "replay", t: 0.2 } },
    },
    "loop tail": { kind: "loop-tail", state: { ...plain, rewind: 0.5 } },
  };

  test("covers every EDL event kind", () => {
    expect(Object.keys(EFFECT_IMAGES).sort()).toEqual([...EVENT_KINDS].sort());
  });

  test("a plain move image may start a part", () => {
    expect(isRestShot(move, plain)).toBe(true);
  });

  test("no image of any effect may start a part", () => {
    for (const [kind, images] of Object.entries(EFFECT_IMAGES)) {
      for (const image of images) {
        expect([kind, isRestShot(image, plain)]).toEqual([kind, false]);
        // Labelled a plain move by mistake, its state still refuses it.
        if (image.state !== plain) {
          expect([kind, isRestShot({ ...image, kind: "move" }, plain)]).toEqual(
            [kind, false],
          );
        }
      }
    }
    for (const [name, image] of Object.entries(OTHER_IMAGES)) {
      expect([name, isRestShot(image, plain)]).toEqual([name, false]);
      expect([name, isRestShot({ ...image, kind: "move" }, plain)]).toEqual([
        name,
        false,
      ]);
    }
  });

  test("on a timeline with every effect, no boundary falls inside one", () => {
    // Plain moves between runs of each effect's images, 12 frames a run.
    const shots: { kind: string; state: object }[] = [];
    const effects = [
      ...Object.values(EFFECT_IMAGES).flat(),
      ...Object.values(OTHER_IMAGES),
    ];
    for (const image of effects) {
      shots.push(move, move);
      for (let i = 0; i < 12; i += 1) shots.push(image);
    }
    shots.push(move);
    for (const workers of [2, 3, 4, 5, 8, 16]) {
      const parts = partsOf(shots.length, workers, (i) =>
        isRestShot(shots[i], plain),
      );
      for (const [from] of parts.slice(1)) {
        expect(shots[from]).toBe(move);
      }
      expect(parts.at(-1)?.[1]).toBe(shots.length);
    }
  });
});
