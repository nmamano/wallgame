import { describe, expect, it } from "bun:test";

import { buildHandcraftedSeedRows } from "../../shared/domain/handcrafted-puzzle-rows";
import {
  isBotLaunchReady,
  savedPuzzleSeedRowSchema,
  SYNTHETIC_AUTHOR,
} from "../../shared/contracts/puzzles";
import { botSupportsPosition } from "../../shared/domain/bot-capability";
import { PUZZLES, getPuzzleIds } from "../../shared/domain/puzzles";
import { GameState } from "../../shared/domain/game-state";
import { resolveSavedPuzzleLaunch } from "../../shared/domain/puzzle-lead-in";

/**
 * The ten authored puzzles, restated as ordinary saved_puzzles rows.
 *
 * The conversion is where this feature can go quietly wrong: a row that parses
 * but describes a different position would ship a puzzle nobody can solve, and
 * nothing downstream would notice. So these check the POSITION survives, not
 * just that the shape does.
 */

const rows = buildHandcraftedSeedRows(1);
const rowFor = (scriptedId: string) =>
  rows.find((row) => row.legacyScriptedId === scriptedId)!;

describe("handcrafted puzzles as saved rows", () => {
  it("produces one row per authored puzzle, in order", () => {
    expect(rows).toHaveLength(getPuzzleIds().length);
    expect(rows.map((row) => row.legacyScriptedId)).toEqual(getPuzzleIds());
    expect(rows.map((row) => row.sortIndex)).toEqual(
      rows.map((_, index) => index + 1),
    );
  });

  it("numbers from wherever it is told to start", () => {
    // The numbering is the caller's decision because sort_index is unique
    // across the whole table and the display name carries the number a share
    // link resolves by.
    expect(buildHandcraftedSeedRows(34)[0].sortIndex).toBe(34);
  });

  it("every row satisfies the boundary contract", () => {
    for (const row of rows) {
      const parsed = savedPuzzleSeedRowSchema.safeParse({ id: "x", ...row });
      expect(parsed.success).toBe(true);
    }
  });

  it("keeps the position exactly, walls and all", () => {
    for (const row of rows) {
      const authored = PUZZLES[row.legacyScriptedId!];
      const config = row.config;
      if (config.variant !== "custom-setup-classic") {
        throw new Error("authored puzzles are classic races, not mouse hunts");
      }
      expect(config.boardWidth).toBe(authored.boardWidth);
      expect(config.boardHeight).toBe(authored.boardHeight);
      expect(config.variantConfig.pawns.p1.cat).toEqual(authored.p1Cat);
      expect(config.variantConfig.pawns.p1.home).toEqual(authored.p1Home);
      expect(config.variantConfig.pawns.p2.cat).toEqual(authored.p2Cat);
      expect(config.variantConfig.pawns.p2.home).toEqual(authored.p2Home);
      expect(config.variantConfig.walls).toEqual(authored.initialWalls);
      // Whoever the puzzle was written for still moves first.
      expect(config.variantConfig.turn.playerId).toBe(authored.humanPlaysAs);
    }
  });

  it("the converted position is playable, and the authored answer still works", () => {
    for (const row of rows) {
      const authored = PUZZLES[row.legacyScriptedId!];
      const state = new GameState(
        {
          ...row.config,
          timeControl: { initialSeconds: 600, incrementSeconds: 0 },
          rated: false,
        } as never,
        0,
      );
      expect(state.status).toBe("playing");
      expect(state.turn).toBe(authored.humanPlaysAs);

      // The puzzle's own first solution move must be legal from the converted
      // position. If the conversion drifted, this is what would catch it.
      const solution = authored.moves[0]?.[0];
      expect(solution).toBeDefined();
      const next = state.applyGameAction({
        kind: "move",
        playerId: authored.humanPlaysAs,
        move: solution,
        timestamp: 1,
      });
      expect(next.turn).not.toBe(authored.humanPlaysAs);
    }
  });

  it("carries the author and the 1-5 tier, and drops the vibes rating", () => {
    expect(rowFor("1").author).toBe("Nilo");
    expect(rowFor("10").author).toBe("Tim");
    for (const row of rows) {
      expect(row.author).not.toBe(SYNTHETIC_AUTHOR);
      expect(row.difficulty).toBeGreaterThanOrEqual(1);
      expect(row.difficulty).toBeLessThanOrEqual(5);
    }
    // The easiest authored puzzle was rated 1350 and the hardest 1850; those
    // numbers are gone, and only the tier a player sees survives.
    expect(rowFor("1").difficulty).toBe(1);
    expect(rowFor("10").difficulty).toBe(5);
  });

  it("seeds every row ENABLED", () => {
    // Because seeding them off would delete ten working puzzles from the site:
    // the code that used to render them is gone, and disabled rows are
    // filtered out of the listing. Nothing about how they PLAY changes here —
    // until a bot declares custom-setup-classic they all resolve to their
    // authored line, which is exactly what players get today. The acceptance
    // gate is the bot rollout, not this flag.
    expect(rows.every((row) => row.enabled === true)).toBe(true);
  });

  it("carries no provenance, because nothing generated them", () => {
    for (const row of rows) {
      expect(row.source).toBeNull();
      expect(row.sourceFingerprint).toBeNull();
    }
  });

  describe("which puzzles a bot can play", () => {
    /** PuzzleBot's real declaration as of 2026-08-04. */
    const puzzleBot = {
      "custom-setup-classic": {
        boardWidth: { min: 4, max: 12 },
        boardHeight: { min: 4, max: 10 },
      },
    };

    it("is decided by the BOT's declaration, not by a constant in here", () => {
      const playable = rows
        .filter((row) =>
          botSupportsPosition(
            puzzleBot,
            row.config.variant,
            row.config.boardWidth,
            row.config.boardHeight,
          ),
        )
        .map((row) => row.legacyScriptedId);
      // Puzzles 2, 3 and 9 are three rows tall and PuzzleBot declares a
      // minimum of four, so it will not take them. That is a fact about what
      // the bot advertises — change the declaration and this answer changes,
      // which is the point.
      expect(playable).toEqual(["1", "4", "5", "6", "7", "8", "10"]);
    });

    it("treats every human-as-P1 row as launchable against a bot", () => {
      for (const row of rows) {
        if (row.config.variantConfig.turn.playerId !== 1) continue;
        expect(isBotLaunchReady(row)).toBe(true);
      }
    });

    it("treats the human-as-P2 row with no lead-in as NOT launchable", () => {
      // Puzzle 2 is human-as-P2 with no stored bot opening move, so there is
      // no legal P1 move to start from whatever bot is online. It is a good
      // puzzle; it is just one played against its authored line.
      expect(PUZZLES["2"].humanPlaysAs).toBe(2);
      expect(rowFor("2").leadIn).toBeNull();
      expect(isBotLaunchReady(rowFor("2"))).toBe(false);
      expect(
        savedPuzzleSeedRowSchema.safeParse({ id: "x", ...rowFor("2") }).success,
      ).toBe(true);
    });

    it("becomes launchable once a lead-in is stored", () => {
      // The baseline that makes the previous case mean something: the row is
      // not permanently excluded, it simply lacks the one thing required.
      const withLeadIn = structuredClone(rowFor("2"));
      withLeadIn.leadIn = { piece: "cat", from: [0, 2] };
      expect(isBotLaunchReady(withLeadIn)).toBe(true);
    });

    it("refuses a stray lead-in on a puzzle that does not want one", () => {
      const strayed = structuredClone(rowFor("1"));
      strayed.leadIn = { piece: "cat", from: [0, 2] };
      expect(
        savedPuzzleSeedRowSchema.safeParse({ id: "x", ...strayed }).success,
      ).toBe(false);
    });

    it("launches a bot-playable row with the human moving first", () => {
      // The server derives seat and lead-in from the row; a P1 puzzle must
      // open on the authored position with nothing played yet.
      const launch = resolveSavedPuzzleLaunch(rowFor("1"));
      expect(launch.humanIsPlayer1).toBe(true);
      expect(launch.leadInMove).toBeNull();
      expect(launch.config).toEqual(rowFor("1").config);
    });
  });

  describe("provenance pairing", () => {
    it("refuses a fingerprint with no source", () => {
      const orphaned = structuredClone(rowFor("5"));
      orphaned.sourceFingerprint = "orphan";
      expect(
        savedPuzzleSeedRowSchema.safeParse({ id: "x", ...orphaned }).success,
      ).toBe(false);
    });

    it("refuses a source with no fingerprint", () => {
      const orphaned = structuredClone(rowFor("5"));
      orphaned.source = {
        candidateId: "c",
        fingerprint: "fp",
        bestMove: "a1",
        beforeDistance: 1,
        afterDistance: 0,
        delta: -1,
        evaluatedAt: new Date(0).toISOString(),
        origin: "o",
        engine: "e",
      };
      expect(
        savedPuzzleSeedRowSchema.safeParse({ id: "x", ...orphaned }).success,
      ).toBe(false);
    });
  });
});
