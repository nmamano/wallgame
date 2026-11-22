/**
 * The deep check of a missed win (labels.ts MissedWin, C78: the puzzle
 * ending shows a position where a player missed a win, and the site plays
 * it against PuzzleBot). For each ply, on the 4090:
 *
 * - the position before the played move: the chance for the mover and the
 *   engine's best move;
 * - the position after the played move: the chance for the mover;
 * - a self-play from the position before: the engine's best move for each
 *   side in turn, applied with the game rules here (the rules, not the
 *   engine, say where the game ends), at most the mover's DEEP_WIN_TURNS.max
 *   turns.
 *
 * The engine is PuzzleBot's (the bot-client config's dw-puzzle command, the
 * engine the viewer plays on the site) at DEEP_SAMPLES, without its losing
 * fallback: the fallback makes the losing side play naive moves
 * (info/puzzle-platform.md), and the check must see the defender's best
 * line. labels.ts judges the numbers; this file only measures.
 */
import type { ConfigFile } from "../../../official-custom-bot-client/src/config-schema";
import type { GameState } from "../../../shared/domain/game-state";
import type { PlayerId } from "../../../shared/domain/game-types";
import { moveFromStandardNotation } from "../../../shared/domain/standard-notation";
import { winChance } from "../daily-candidates";
import type { EngineLink } from "../engine-eval";
import { replayDistances } from "../race-replay";
import type { DeepCheck, SemanticGame } from "./facts";
import { DEEP_WIN_TURNS } from "./labels";

export const DEEP_BOT = "dw-puzzle";
/** 4x PuzzleBot's 5000 (2026-11-22): the depth of the 33 checks of 11-22. */
export const DEEP_SAMPLES = 20000;

/** PuzzleBot's engine command at DEEP_SAMPLES, without the losing fallback. */
export const deepCommand = (config: ConfigFile): string => {
  const command = config.engineCommands[DEEP_BOT];
  if (!command) throw new Error(`no engine command for ${DEEP_BOT}`);
  if (!/--samples \d+/.test(command))
    throw new Error(`${DEEP_BOT}'s command has no --samples: ${command}`);
  return command
    .replace(/--samples \d+/, `--samples ${DEEP_SAMPLES}`)
    .replace(/ --losing_fallback_eval \S+/, "")
    .replace(/ --losing_fallback(?=\s|$)/, "");
};

/** `state` after `notation` by the side to move (the game rules). */
const applied = (state: GameState, notation: string): GameState =>
  state.applyGameAction({
    kind: "move",
    move: moveFromStandardNotation(notation, state.config.boardHeight),
    playerId: state.turn,
    timestamp: 0,
  });

/**
 * One engine session on `game`'s first `plies` moves; `use` gets its id.
 * The session ends whatever `use` does.
 */
const withSession = async <T>(
  link: EngineLink,
  game: SemanticGame,
  plies: number,
  use: (bgsId: string) => Promise<T>,
): Promise<T> => {
  const bgsId = `deep-${game.gameId}-${plies}`;
  const started = await link.request({
    type: "start_game_session",
    bgsId,
    botId: "deep-check",
    config: {
      variant: game.variant,
      boardWidth: game.boardWidth,
      boardHeight: game.boardHeight,
      initialState: game.initialState,
    },
  });
  if (started.success === false)
    throw new Error(`start_game_session: ${started.error ?? "refused"}`);
  try {
    for (let k = 0; k < plies; k++) {
      const a = await link.request({
        type: "apply_move",
        bgsId,
        expectedPly: k,
        move: game.moves[k],
      });
      if (a.success === false)
        throw new Error(`apply_move ply ${k}: ${a.error ?? "refused"}`);
    }
    return await use(bgsId);
  } finally {
    await link.request({ type: "end_game_session", bgsId }).catch(() => null);
  }
};

/** The engine's value (P1's view) and best move; null if it gives none. */
const evaluate = async (link: EngineLink, bgsId: string, ply: number) => {
  const r = await link.request({
    type: "evaluate_position",
    bgsId,
    expectedPly: ply,
  });
  if (r.success === false || typeof r.evaluation !== "number") return null;
  return {
    value: r.evaluation,
    best: typeof r.bestMove === "string" && r.bestMove ? r.bestMove : null,
  };
};

/** The deep check of the move at `ply` of `game` (see the file comment). */
export const deepCheck = async (
  link: EngineLink,
  game: SemanticGame,
  ply: number,
): Promise<DeepCheck> => {
  const replay = replayDistances(game);
  const mover: PlayerId = replay.movers[ply];
  const chance = (value: number) => +winChance(value, mover).toFixed(3);
  const first = await withSession(link, game, ply, async (bgsId) => {
    const start = await evaluate(link, bgsId, ply);
    const selfPlay: string[] = [];
    let selfPlayWinner: PlayerId | null = null;
    let state = replay.states[ply];
    let next = start;
    // The mover's last allowed turn is ply index 2 * (max - 1).
    while (next?.best && selfPlay.length < 2 * DEEP_WIN_TURNS.max - 1) {
      const move = next.best;
      state = applied(state, move);
      const a = await link.request({
        type: "apply_move",
        bgsId,
        expectedPly: ply + selfPlay.length,
        move,
      });
      if (a.success === false)
        throw new Error(`self-play apply_move: ${a.error ?? "refused"}`);
      selfPlay.push(move);
      if (state.status === "finished") {
        selfPlayWinner = state.result?.winner ?? null;
        break;
      }
      next = await evaluate(link, bgsId, ply + selfPlay.length);
    }
    return { start, selfPlay, selfPlayWinner };
  });
  const after = await withSession(link, game, ply + 1, (bgsId) =>
    evaluate(link, bgsId, ply + 1),
  );
  return {
    ply,
    before: first.start && chance(first.start.value),
    after: after && chance(after.value),
    best: first.start?.best ?? null,
    selfPlay: first.selfPlay,
    selfPlayWinner: first.selfPlayWinner,
  };
};
