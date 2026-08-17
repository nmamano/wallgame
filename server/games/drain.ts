/**
 * The drain: a switch that stops NEW games from starting while the games
 * already under way finish on their own.
 *
 * It exists so a deploy no longer has to be timed against a quiet minute.
 * Sessions live in this process's memory, so a restart ends every game in
 * flight; the answer is to stop taking new ones, wait for the live count to
 * reach zero, and only then restart. Rehydrating games from the database was
 * the alternative and Nil rejected it on 2026-08-17: roughly thirty times the
 * database writes, for a case that a two-minute wait covers.
 *
 * ## Where the switch lives, and why it is a file
 *
 * A file inside the machine, whose MODIFICATION TIME is the moment the drain
 * started. Touch it to drain, remove it to stop, touch it again to hold longer.
 *
 * The file has no content on purpose: the time is already there, so ops needs
 * no clock arithmetic in a shell and this module needs no parser.
 *
 * A file also has no internet-facing write path, which is why there is no
 * token, no admin route and no new secret here. This server has no admin
 * surface to extend - the one credential it holds, OFFICIAL_BOT_TOKEN, belongs
 * to the bot client and must not become an ops key. Whoever can write this file
 * can already run code in the machine, so `fly ssh console` IS the
 * authentication, and it is the path the deploy runbook already uses.
 *
 * A restart clears the drain, which is the state a finished deploy wants.
 */

import { statSync } from "node:fs";

/**
 * The sentinel. Inside the container, not in the repo working tree: the flag
 * belongs to one running machine, and a restart must forget it.
 */
export const DRAIN_SENTINEL_PATH = "/tmp/wallgame-drain";

/**
 * How long a drain lasts, counted from the last touch of the sentinel.
 *
 * THIS IS A DEADMAN SWITCH, NOT A WAIT BUDGET. Real waits run longer than this
 * - one on 2026-08-16 ran over an hour - so whoever babysits a drain RE-TOUCHES
 * the sentinel on every poll cycle. What this constant buys is the other case:
 * if the babysitter dies, the site heals itself within twenty minutes instead of
 * refusing new games until somebody notices.
 *
 * The procedure is in ops-private/wallgame-deploy.md.
 */
export const DRAIN_TTL_MS = 20 * 60 * 1000;

/**
 * What a player is told, and the only place it is written.
 *
 * It names no deploy, no restart and no maintenance - Nil's standing copy rule.
 * It answers the three things the player actually wants: what happened, whether
 * the game they are in is at risk, and what to do now.
 */
export const NEW_GAMES_PAUSED_MESSAGE =
  "New games are paused for a few minutes. Any game already in progress keeps going - please try again shortly.";

export interface DrainState {
  draining: boolean;
  /** When the current drain lapses, or null when nothing is draining. */
  expiresAtMs: number | null;
}

const NOT_DRAINING: DrainState = { draining: false, expiresAtMs: null };

/**
 * The decision, with no filesystem in it: given when the sentinel was last
 * touched, is a drain running now?
 *
 * Separated from the read below so the expiry rule can be tested at its
 * boundaries without touching a global path.
 */
export const drainStateFrom = (
  sentinelTouchedAtMs: number | null,
  now: number,
): DrainState => {
  if (sentinelTouchedAtMs === null) {
    return NOT_DRAINING;
  }
  const expiresAtMs = sentinelTouchedAtMs + DRAIN_TTL_MS;
  if (now >= expiresAtMs) {
    return NOT_DRAINING;
  }
  return { draining: true, expiresAtMs };
};

/**
 * The live state of the switch.
 *
 * Any failure to read the sentinel counts as "not draining". That direction is
 * deliberate: a drain that fails to engage costs one interrupted game at the
 * next deploy, while a drain that engages by accident would refuse every new
 * game on the site.
 */
export const readDrainState = (now: number = Date.now()): DrainState => {
  let touchedAtMs: number | null = null;
  try {
    touchedAtMs = statSync(DRAIN_SENTINEL_PATH).mtimeMs;
  } catch {
    touchedAtMs = null;
  }
  return drainStateFrom(touchedAtMs, now);
};

/**
 * Thrown where a new game would have been registered. Its message is what the
 * player reads, so every surface can answer with it and none has to invent
 * wording of its own.
 */
export class NewGamesPausedError extends Error {
  constructor() {
    super(NEW_GAMES_PAUSED_MESSAGE);
    this.name = "NewGamesPausedError";
  }
}

/** Refuses to let a new game start while a drain is running. */
export const assertNewGamesAllowed = (now: number = Date.now()): void => {
  if (readDrainState(now).draining) {
    throw new NewGamesPausedError();
  }
};
