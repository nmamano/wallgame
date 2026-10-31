/**
 * What each move MEANS, from its facts (facts.ts): one label, a strength in
 * [0, 1], secondary tags, the hunt the story is about, and links between
 * moves (a blunder and its punish). Pure and deterministic: no model.
 *
 * Nil, 2026-10-29: the daily videos place memes where nothing happened. The
 * Director's blind test (same day) showed the gap is game MEANING: a cat 2
 * steps from its mouse is routine when the defender, with two actions, just
 * blocks. So every label that claims the game changed (threat, blunder,
 * turn, punish, trap-closes) needs the engine; the board alone gives only
 * what a viewer sees (detour, self-trap, escape, standoff, the capture).
 * One label set with the Director Rewriter's meme list (2026-10-29): a meme
 * goes only on a move whose label matches its line.
 *
 * KNOWN LIMITS. A label can read the NEXT move (a turn is a flip that the
 * reply keeps), so the labels of an unfinished game can change when one
 * more move is scored. The strength of an engine label saturates at a drop
 * of 0.5 in win chance, so several blunders can share strength 1: rank by
 * strength, then by drop, when picking moments.
 */
import type { PlayerId, Variant } from "../../../shared/domain/game-types";
import { minJumpFor, type Hunt } from "../race-replay";
import type { GameFacts, HuntChange, PlyFacts } from "./facts";

export const LABELS = [
  "capture",
  "home",
  "turn",
  "blunder",
  "punish",
  "trap-closes",
  "save",
  "escape",
  "box-in",
  "threat",
  "self-trap",
  "detour",
  "standoff",
  "quiet",
] as const;
/** In priority order: when several fit a move, the first is its label. */
export type Label = (typeof LABELS)[number];

/**
 * engine-losing: a threat after which the engine gives the mover under 50%
 * (review 114 N1). The danger is real on the board, but the move is no
 * feat: a meme may show the defender's fear, never cheer the threat.
 */
export type Tag =
  | Label
  | "missed-wall"
  | "missed-punish"
  | "kept-gain"
  | "engine-losing"
  | "own-wall"
  | "dodge";

/** A cat this close reaches its prey on its next turn (two steps). */
export const THREAT_WALK = 2;
/** A drop in the mover's win chance this large is a blunder. */
export const BLUNDER_DROP = 0.2;
/**
 * The engine's noise: same-seed reruns moved a position by up to 0.07
 * (measured 2026-10-25), 0.035 in win chance, so a reply that gives back
 * less than this keeps a blunder's gain.
 */
export const KEEP_DROP = 0.05;
/** One side is clearly ahead at this win chance (a turn flips it). */
export const CLEAR_CHANCE = 0.65;
/** From this win chance on, the winner stays ahead to the end. */
export const SEALED_CHANCE = 0.9;
/** A save or a self-trap raises a walk by this much at least. */
export const RISE_WALK = 3;
/** An escape ends at least this far from the cat. */
export const ESCAPE_WALK = 4;
/**
 * A box-in (Wall Game PM, 2026-10-29): the move's walls cut a mouse's room
 * (facts.ts MouseRoom) by this share or more...
 */
export const BOX_CUT = 0.4;
/** ...and to this many cells or fewer (8x8 has 64). */
export const BOX_ROOM = 25;

/** Plies, 0-based. */
interface LinkEnds {
  from: number;
  to: number;
}

export type Link =
  | (LinkEnds & {
      kind: "blunder-punish";
      /**
       * Nil, 2026-10-29, on VX-IPenv: "it doesn't get punished". The punish
       * changes a walk by COST_WALK or more, and the next move does not
       * bring that walk back within UNDO_WALK of its old value. False means
       * the board does not show the blunder's cost.
       */
      costShown: boolean;
    })
  | (LinkEnds & {
      kind: "threat-save" | "threat-escape" | "sealed-capture";
    });

/** A punish shows its cost when it changes a walk by this much... */
export const COST_WALK = 5;
/** ...and the next move leaves that walk more than this from where it was. */
export const UNDO_WALK = 2;

/** costShown of the punish at `ply` (see Link). */
const costShownAt = (plies: PlyFacts[], ply: number): boolean =>
  // hunts[i] is the same hunt on every ply: facts.ts lists them in
  // huntsFor order, which is fixed per variant.
  plies[ply].hunts.some((h, i) => {
    if (Math.abs(h.after - h.before) < COST_WALK) return false;
    const next = plies[ply + 1];
    if (!next) return true;
    return Math.abs(next.hunts[i].after - h.before) > UNDO_WALK;
  });

/** The hunt a move's story is about, as the renderer's explain event wants it. */
export interface Focus {
  hunter: Hunt["hunter"];
  target: Hunt["target"];
  /** The walls the move placed, standard notation. */
  walls: string[];
  /** The hunt's walk before and after the move (race-replay.ts huntWalks). */
  before: number;
  after: number;
}

/**
 * The race as the counters show it (Director, 2026-10-31, C36): each side's
 * shortest walk and the side to move. Null walks: a variant where a side
 * hunts nothing.
 */
export interface RaceState {
  walks: Record<PlayerId, number | null>;
  toMove: PlayerId;
}

export interface PlyLabel {
  ply: number;
  moveNumber: number;
  mover: PlayerId;
  label: Label;
  strength: number;
  /** Every label that fits, and the sub-kinds; includes `label`. */
  tags: Tag[];
  focus: Focus;
  race: { before: RaceState; after: RaceState };
  /**
   * The mover's race gain against a plain two-step move (raceGain): 0 for a
   * step, +2 for walls that add 4 to the other side's walk.
   */
  raceGain: number;
  /** With the own-wall tag: the wall between the cat and the mouse, and when its owner placed it. */
  ownWall?: { wall: string; ply: number };
}

/** The race before move `ply` (or after the last when ply = length). */
const raceAt = (plies: PlyFacts[], ply: number): RaceState => {
  const walkOf = (f: PlyFacts, p: PlayerId, when: "before" | "after") => {
    const ws = f.hunts.filter((h) => h.hunter.player === p).map((h) => h[when]);
    return ws.length === 0 ? null : Math.min(...ws);
  };
  if (ply < plies.length) {
    const f = plies[ply];
    return {
      walks: { 1: walkOf(f, 1, "before"), 2: walkOf(f, 2, "before") },
      toMove: f.mover,
    };
  }
  const f = plies[ply - 1];
  return {
    walks: { 1: walkOf(f, 1, "after"), 2: walkOf(f, 2, "after") },
    toMove: f.mover === 1 ? 2 : 1,
  };
};

/**
 * The race from P1's side in moves, not steps: a move takes up to two steps,
 * and the side to move goes first, so a tie belongs to it. A plain step keeps
 * this value; a wall that adds 4 to the other walk moves it by 2.
 */
const tempo = (r: RaceState): number | null => {
  const { 1: a, 2: b } = r.walks;
  if (a === null || b === null) return null;
  return b - a + (r.toMove === 1 ? 1 : -1);
};

/** The race in words, as the counters show it. */
export const raceWords = (
  r: RaceState,
  names: Record<PlayerId, string>,
): string => {
  const { 1: a, 2: b } = r.walks;
  if (a === null || b === null) return "no race";
  if (a === b) return `tied ${a}-${b}, ${names[r.toMove]} to move`;
  const lead: PlayerId = a < b ? 1 : 2;
  return `${names[lead]} leads by ${Math.abs(a - b)} (${a}-${b}, ${names[r.toMove]} to move)`;
};

/** Who leads on the counters (the lower walk); null for a tie or no race. */
const counterLeader = (r: RaceState): PlayerId | null => {
  const { 1: a, 2: b } = r.walks;
  if (a === null || b === null || a === b) return null;
  return a < b ? 1 : 2;
};

/**
 * The counters show the move (C36 D): it flips who leads, or turns a tie into
 * a lead for the mover. The image check counts this as seen.
 */
export const countersShow = (l: PlyLabel): boolean => {
  const was = counterLeader(l.race.before);
  const now = counterLeader(l.race.after);
  if (now === null) return false;
  return was === null ? now === l.mover : was !== now;
};

/** The wall that would stand between two adjacent cells, in notation. */
const wallBetween = (a: string, b: string): string => {
  const [fa, ra] = [a.charCodeAt(0), Number(a.slice(1))];
  const [fb, rb] = [b.charCodeAt(0), Number(b.slice(1))];
  if (ra === rb) return `>${String.fromCharCode(Math.min(fa, fb))}${ra}`;
  return `^${a[0]}${Math.min(ra, rb)}`;
};

const manhattan = (a: string, b: string) =>
  Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) +
  Math.abs(Number(a.slice(1)) - Number(b.slice(1)));

/**
 * A move worth a row and a seen check: any label but quiet, or a quiet move
 * with a board beat a viewer sees (a dodge, a cat stopped by its own wall).
 */
export const isMoment = (l: Pick<PlyLabel, "label" | "tags">): boolean =>
  l.label !== "quiet" ||
  l.tags.includes("dodge") ||
  l.tags.includes("own-wall");

/** A race gain this large makes a move a moment (C36 B). */
export const MOMENT_GAIN = 2;

export interface GameLabels {
  plies: PlyLabel[];
  links: Link[];
  /**
   * The game's turning point in a newcomer's words (C36 F), from the engine
   * curve (or the counters with no engine). Plies, 0-based.
   */
  turningPoint: string;
}

const clamp01 = (x: number) =>
  Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;

const own = (f: PlyFacts) => f.hunts.filter((h) => h.hunter.player === f.mover);
const theirs = (f: PlyFacts) =>
  f.hunts.filter((h) => h.hunter.player !== f.mover);
const rise = (h: HuntChange) => h.after - h.before;
const largest = (hunts: HuntChange[], by: (h: HuntChange) => number) =>
  hunts.reduce<HuntChange | null>(
    (best, h) => (best === null || by(h) > by(best) ? h : best),
    null,
  );
const best = (hunts: HuntChange[]) =>
  hunts.length === 0 ? null : Math.min(...hunts.map((h) => h.before));
const bestAfter = (hunts: HuntChange[]) =>
  hunts.length === 0 ? null : Math.min(...hunts.map((h) => h.after));
const focusOf = (f: PlyFacts, h: HuntChange): Focus => ({
  hunter: h.hunter,
  target: h.target,
  walls: f.walls,
  before: h.before,
  after: h.after,
});
const isAnimal = (h: HuntChange) => h.target.type !== "home";
const adjacent = (a: string, b: string) => {
  const col = Math.abs(a.charCodeAt(0) - b.charCodeAt(0));
  const row = Math.abs(Number(a.slice(1)) - Number(b.slice(1)));
  return col + row === 1;
};

/** Each label that fits one ply on its own, with its strength and focus. */
interface Fit {
  label: Label;
  strength: number;
  hunt: HuntChange;
}

export const labelGame = (facts: GameFacts): GameLabels => {
  const { plies } = facts;
  const variant = facts.game.variant as Variant;
  const minJump = minJumpFor(variant);
  const fits: Fit[][] = plies.map(() => []);
  const tags: Tag[][] = plies.map(() => []);
  const links: Link[] = [];
  const fit = (ply: number, label: Label, strength: number, hunt: HuntChange) =>
    fits[ply].push({ label, strength: clamp01(strength), hunt });

  // A blunder needs the engine; a game-ending move is never one.
  const blunders = new Set(
    plies.flatMap((f) =>
      f.engine && !f.end && f.engine.delta <= -BLUNDER_DROP ? [f.ply] : [],
    ),
  );
  const threats = new Map<number, HuntChange>();
  const races = plies.map((_, k) => raceAt(plies, k));
  races.push(raceAt(plies, plies.length));
  /** The mover's tempo change across plies [from, to], 0 when there is no race. */
  const gainOver = (from: number, to: number, mover: PlayerId) => {
    const a = tempo(races[from]);
    const b = tempo(races[to + 1]);
    if (a === null || b === null) return 0;
    return (mover === 1 ? 1 : -1) * (b - a);
  };
  const gains = plies.map((f, k) => gainOver(k, k, f.mover));
  /**
   * A wall in a wall war (C36 B): the reply gives the gain back, or the move
   * only gives back the reply before it. Both leave the race within 2 over two
   * plies, so the move is no moment.
   */
  const answered = (ply: number) => {
    const m = plies[ply].mover;
    const back =
      ply + 1 < plies.length &&
      Math.abs(gainOver(ply, ply + 1, m)) < MOMENT_GAIN;
    const answers =
      ply > 0 &&
      gains[ply - 1] <= -MOMENT_GAIN &&
      Math.abs(gainOver(ply - 1, ply, m)) < MOMENT_GAIN;
    return back || answers;
  };
  /** Who placed each wall, and when. */
  const wallOwner = new Map<string, { player: PlayerId; ply: number }>();
  const ownWalls = new Map<number, { wall: string; ply: number }>();

  plies.forEach((f, ply) => {
    for (const w of f.walls) wallOwner.set(w, { player: f.mover, ply });
    if (f.hunts.length === 0) {
      throw new Error(
        `ply ${ply}: the variant ${variant} has no hunt, so no move has a focus`,
      );
    }
    const e = f.engine;
    const mine = own(f);
    const yours = theirs(f);
    const moved = largest(f.hunts, (h) => Math.abs(rise(h))) ?? f.hunts[0];

    // The end on the board.
    if (f.end) {
      // Whoever moved: a mouse can also step onto the cat (v-lQeZ8T's
      // last move, 2026-10-29), and that is the capture too.
      const caught =
        mine.find((h) => h.after === 0) ?? f.hunts.find((h) => h.after === 0);
      if (caught) {
        fit(ply, caught.target.type === "home" ? "home" : "capture", 1, caught);
      }
    }

    // The engine's verdict on the move.
    if (e && !f.end) {
      if (blunders.has(ply)) {
        // A turn hands the game over: the favored side flips, and the reply
        // keeps it (a reply that is a blunder too gives it back at once).
        const flips =
          e.before >= CLEAR_CHANCE &&
          e.after <= 1 - CLEAR_CHANCE &&
          !blunders.has(ply + 1);
        // The hunt the mover now loses on: the other side's closest cat.
        const danger =
          largest(yours, (h) => -h.after) ??
          largest(mine, (h) => rise(h)) ??
          moved;
        fit(ply, flips ? "turn" : "blunder", -e.delta / 0.5, danger);
        if (flips) tags[ply].push("blunder");
        const missed = e.bestWalls.filter((w) => !f.walls.includes(w));
        if (missed.length > 0) tags[ply].push("missed-wall");
      }
      const prev = plies[ply - 1];
      if (prev && blunders.has(ply - 1) && prev.mover !== f.mover) {
        if (e.delta > -KEEP_DROP) {
          // A punish is a reply that keeps the gain AND that a viewer can
          // see (VR1, 2026-10-29: "both walks stay at 12" is no punish):
          // the other side's cat sent around a wall (minJump or more), or
          // the mover's own cat within reach. A reply that only keeps the
          // gain is tagged kept-gain and keeps its own label.
          const theirRise = largest(yours, rise);
          const reach = mine.find(
            (h) =>
              isAnimal(h) &&
              h.after > 0 &&
              h.after <= THREAT_WALK &&
              h.after < h.before,
          );
          // C36 C: a wall punish must show its cost on the board
          // (costShown); a punish of a blunder no viewer sees is no punish.
          const seen =
            (theirRise !== null &&
              rise(theirRise) >= minJump &&
              costShownAt(plies, ply)) ||
            reach !== undefined;
          if (seen) {
            const drop = prev.engine ? -prev.engine.delta : 0;
            fit(
              ply,
              "punish",
              drop / 0.5,
              theirRise !== null && rise(theirRise) >= minJump
                ? theirRise
                : reach!,
            );
            links.push({
              kind: "blunder-punish",
              from: ply - 1,
              to: ply,
              costShown: costShownAt(plies, ply),
            });
          } else {
            tags[ply].push("kept-gain");
          }
        } else if (blunders.has(ply)) {
          tags[ply].push("missed-punish");
        }
      }
    }

    // A threat: the mover's cat comes within reach, so the defender must
    // answer or lose. The board decides, not the engine (Director, 2026-10-31,
    // on ymU8fqsF ply 14): a cat 2 steps from the mouse is the danger a
    // viewer sees, even when the engine knows the defender has an answer.
    // The engine only sets the strength.
    for (const h of mine.filter(isAnimal)) {
      if (h.after === 0 || h.after > THREAT_WALK || h.before <= THREAT_WALK)
        continue;
      threats.set(ply, h);
      fit(ply, "threat", e ? Math.max(0.2, (e.after - 0.5) * 2) : 0.5, h);
      if (e && e.after < 0.5) tags[ply].push("engine-losing");
    }

    // The defender's answer to the threat just before.
    const threat = threats.get(ply - 1);
    if (threat && !blunders.has(ply)) {
      const h = yours.find(
        (y) =>
          y.hunter.player === threat.hunter.player &&
          y.hunter.type === threat.hunter.type &&
          y.target.type === threat.target.type,
      );
      if (h && rise(h) >= RISE_WALK) {
        const ran = h.targetFrom !== h.targetTo;
        if (ran && h.before === 1 && h.after >= ESCAPE_WALK) {
          fit(ply, "escape", rise(h) / 8, h);
          links.push({ kind: "threat-escape", from: ply - 1, to: ply });
        } else {
          fit(ply, "save", rise(h) / 10, h);
          links.push({ kind: "threat-save", from: ply - 1, to: ply });
        }
      }
    } else if (!blunders.has(ply)) {
      // An escape with no engine threat before it: the mouse still ran.
      for (const h of yours.filter(isAnimal)) {
        if (h.before !== 1 || h.after < ESCAPE_WALK) continue;
        if (h.targetFrom === h.targetTo) continue;
        fit(ply, "escape", rise(h) / 8, h);
      }
    }

    // A mouse boxed in by the move's walls. Under a higher label (a
    // blunder, a save) it stays a tag, so the engine's verdict stays seen.
    if (f.walls.length > 0) {
      for (const room of f.rooms) {
        const cut = room.before === 0 ? 0 : 1 - room.after / room.before;
        if (cut < BOX_CUT || room.after > BOX_ROOM) continue;
        const h =
          mine.find(
            (x) =>
              x.target.player === room.target.player &&
              x.target.type === room.target.type,
          ) ?? moved;
        fit(ply, "box-in", cut / 0.8, h);
      }
    }

    // What the walls did, as a viewer sees it.
    if (f.walls.length > 0 && !blunders.has(ply)) {
      const theirBefore = best(yours);
      const theirAfter = bestAfter(yours);
      const ownBefore = best(mine);
      const ownAfter = bestAfter(mine);
      const theirRise =
        theirBefore === null || theirAfter === null
          ? 0
          : theirAfter - theirBefore;
      const ownRise =
        ownBefore === null || ownAfter === null ? 0 : ownAfter - ownBefore;
      if (theirRise >= minJump && theirRise >= ownRise) {
        // C36 B: a detour must move the race, and not be a wall-war answer.
        if (gains[ply] >= MOMENT_GAIN && !answered(ply)) {
          fit(ply, "detour", theirRise / 12, largest(yours, rise) ?? moved);
        } else tags[ply].push("detour");
      }
    }
    if (f.walls.length > 0) {
      const ownRise = largest(mine, rise);
      const theirRise = largest(yours, rise);
      if (
        ownRise &&
        rise(ownRise) >= RISE_WALK &&
        rise(ownRise) > (theirRise ? rise(theirRise) : 0)
      ) {
        if (blunders.has(ply)) tags[ply].push("self-trap");
        else fit(ply, "self-trap", rise(ownRise) / 12, ownRise);
      }
    }

    // Face to face with a wall between.
    for (const h of f.hunts.filter(isAnimal)) {
      if (h.after > 1 && adjacent(h.hunterTo, h.targetTo)) {
        const was = h.before > 1 && adjacent(h.hunterFrom, h.targetFrom);
        if (!was) fit(ply, "standoff", 0.3, h);
        // C36 E: the wall that stops the cat is its own side's.
        const wall = wallBetween(h.hunterTo, h.targetTo);
        const owner = wallOwner.get(wall);
        if (!was && owner?.player === h.hunter.player) {
          tags[ply].push("own-wall");
          ownWalls.set(ply, { wall, ply: owner.ply });
        }
      }
    }

    // C36 E: the mover's mouse steps away, or behind a wall.
    for (const h of yours.filter(isAnimal)) {
      if (h.targetFrom === h.targetTo || h.after === 0) continue;
      const behindWall =
        h.after - manhattan(h.hunterTo, h.targetTo) >
        h.before - manhattan(h.hunterFrom, h.targetFrom);
      if (rise(h) >= 2 || (rise(h) >= 1 && behindWall)) {
        if (!tags[ply].includes("dodge")) tags[ply].push("dodge");
      }
    }

    fit(ply, "quiet", 0, moved);
  });

  // The winner's move that seals the game: from it on, the winner stays at
  // SEALED_CHANCE or more to the end.
  const winner = facts.winner;
  if (winner !== null && plies.every((f) => f.engine)) {
    const chance = (k: number) => {
      const f = plies[k];
      return f.mover === winner ? f.engine!.after : 1 - f.engine!.after;
    };
    let from = plies.length - 1;
    while (from > 0 && chance(from - 1) >= SEALED_CHANCE) from--;
    // `from` is the first ply after which the winner stays sealed.
    const f = plies[from];
    if (f?.mover === winner && f.engine!.before < SEALED_CHANCE && !f.end) {
      const h = largest(own(f), (x) => -x.after) ?? f.hunts[0];
      fit(from, "trap-closes", 0.5 + (f.engine!.after - f.engine!.before), h);
      const last = plies.length - 1;
      if (plies[last].end) {
        links.push({ kind: "sealed-capture", from, to: last });
      }
    }
  }

  const labels = plies.map((f, ply): PlyLabel => {
    const order = (l: Label) => LABELS.indexOf(l);
    const sorted = [...fits[ply]].sort(
      (a, b) => order(a.label) - order(b.label),
    );
    const top = sorted[0];
    const all = new Set<Tag>([
      ...sorted
        .filter((x) => x.label !== "quiet" || sorted.length === 1)
        .map((x) => x.label),
      ...tags[ply],
    ]);
    const ownWall = ownWalls.get(ply);
    return {
      ply,
      moveNumber: f.moveNumber,
      mover: f.mover,
      label: top.label,
      strength: top.strength,
      tags: [...all],
      focus: focusOf(f, top.hunt),
      race: { before: races[ply], after: races[ply + 1] },
      raceGain: gains[ply],
      ...(ownWall ? { ownWall } : {}),
    };
  });
  return {
    plies: labels,
    links,
    turningPoint: turningPointOf(facts, labels, links),
  };
};

/** The seat names, "P1"/"P2" when a seat is missing. */
const seatNames = (facts: GameFacts): Record<PlayerId, string> => ({
  1: facts.game.seats.find((s) => s.playerOrder === 1)?.name ?? "P1",
  2: facts.game.seats.find((s) => s.playerOrder === 2)?.name ?? "P2",
});

/**
 * The ply after which the winner stays ahead to the end: on the engine's
 * curve (50% or more) when every move is scored, else on the counters. Then
 * the sealing move and the end.
 */
const turningPointOf = (
  facts: GameFacts,
  labels: PlyLabel[],
  links: Link[],
): string => {
  const winner = facts.winner;
  const names = seatNames(facts);
  const n = facts.plies.length;
  if (winner === null || n === 0) return "No winner: the game is a draw.";
  const W = names[winner];
  const scored = facts.plies.every((f) => f.engine);
  const aheadAfter = (k: number): boolean => {
    if (scored) {
      const f = facts.plies[k];
      const c = f.mover === winner ? f.engine!.after : 1 - f.engine!.after;
      return c >= 0.5;
    }
    return counterLeader(labels[k].race.after) === winner;
  };
  let from = n - 1;
  while (from > 0 && aheadAfter(from - 1)) from--;
  const startAhead = scored
    ? (facts.plies[0].mover === winner
        ? facts.plies[0].engine!.before
        : 1 - facts.plies[0].engine!.before) >= 0.5
    : counterLeader(labels[0].race.before) === winner;
  const at = (k: number) => {
    const l = labels[k];
    const what = l.label === "quiet" ? "" : `, ${l.label}`;
    return `ply ${k} (move ${k + 1}, ${names[l.mover]}${what})`;
  };
  const how = scored ? "on the engine's count" : "on the counters";
  const parts = [
    from === 0 && startAhead
      ? `${W} is ahead from the start ${how} and never falls behind`
      : `${W} is ahead ${how} from ${at(from)} to the end`,
  ];
  const sealed = links.find((k) => k.kind === "sealed-capture");
  if (sealed && sealed.from !== from) {
    parts.push(
      `${at(sealed.from)} seals it (the engine keeps ${W} at 90% or more)`,
    );
  }
  const last = labels[n - 1];
  parts.push(
    last.label === "capture" || last.label === "home"
      ? `${last.label === "home" ? "home" : "the capture"} at ply ${n - 1}`
      : `the game ends at ply ${n - 1} (${facts.game.result.reason})`,
  );
  return `${parts.join("; ")}.`;
};
