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
  "threat",
  "self-trap",
  "detour",
  "standoff",
  "quiet",
] as const;
/** In priority order: when several fit a move, the first is its label. */
export type Label = (typeof LABELS)[number];

export type Tag = Label | "missed-wall" | "missed-punish" | "kept-gain";

/** A cat this close reaches its prey on its next turn (two steps). */
export const THREAT_WALK = 2;
/** The mover's win chance after a move that is a real threat. */
export const THREAT_CHANCE = 0.65;
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

export interface Link {
  kind: "blunder-punish" | "threat-save" | "threat-escape" | "sealed-capture";
  /** Plies, 0-based. */
  from: number;
  to: number;
}

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

export interface PlyLabel {
  ply: number;
  moveNumber: number;
  mover: PlayerId;
  label: Label;
  strength: number;
  /** Every label that fits, and the sub-kinds; includes `label`. */
  tags: Tag[];
  focus: Focus;
}

export interface GameLabels {
  plies: PlyLabel[];
  links: Link[];
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

  plies.forEach((f, ply) => {
    const e = f.engine;
    const mine = own(f);
    const yours = theirs(f);
    const moved = largest(f.hunts, (h) => Math.abs(rise(h))) ?? f.hunts[0];

    // The end on the board.
    if (f.end) {
      const caught = mine.find((h) => h.after === 0);
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
          const seen =
            (theirRise !== null && rise(theirRise) >= minJump) ||
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
            links.push({ kind: "blunder-punish", from: ply - 1, to: ply });
          } else {
            tags[ply].push("kept-gain");
          }
        } else if (blunders.has(ply)) {
          tags[ply].push("missed-punish");
        }
      }
    }

    // A threat: the mover's cat comes within reach, and the engine agrees.
    for (const h of mine.filter(isAnimal)) {
      if (h.after === 0 || h.after > THREAT_WALK || h.before <= THREAT_WALK)
        continue;
      if (!e || e.after < THREAT_CHANCE) continue;
      threats.set(ply, h);
      fit(ply, "threat", (e.after - 0.5) * 2, h);
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
        fit(ply, "detour", theirRise / 12, largest(yours, rise) ?? moved);
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
    return {
      ply,
      moveNumber: f.moveNumber,
      mover: f.mover,
      label: top.label,
      strength: top.strength,
      tags: [...all],
      focus: focusOf(f, top.hunt),
    };
  });
  return { plies: labels, links };
};
