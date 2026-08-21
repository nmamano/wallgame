/**
 * Head-to-head benchmark harness for two Deep-WallWars engines.
 *
 * Plays two models against each other at the MOVE level over the V3 BGS
 * protocol, refereed locally by the shared GameState -- no server, no database,
 * nothing touches wallgame.io. Each side takes its own --samples and its own
 * --*-noise, so a stronger opponent can be handicapped (e.g. 1 sample) while
 * ours searches at full strength, and a candidate's root noise can be swept
 * against a fixed reference. Board size is independent of the model frame: our transformers are
 * always 12x10-framed and smaller games are embedded via BGS padding, so
 * --width/--height set the game, not the network input.
 *
 * Needs a built deep_ww_bgs_engine and the models, so in practice it runs on a
 * GPU box rather than the office VPS. Pass --engine to point at that build.
 *
 * --archive and --experiment have NO DEFAULT ON PURPOSE, so a run that would
 * leave no evidence cannot start. Every completed game is appended to --archive
 * as one JSON line carrying the settings and the seeds that produced it, which
 * is what lets a later Elo fit read the conditions off the game instead of
 * trusting a directory name. Point --archive into deep-wallwars/elo_db.
 *
 * --setup chooses the INITIAL CONDITIONS, not the variant. `fixed` is each
 * variant's standard opening position; `random-start` generates a fresh legal
 * position per game from the seed. Both work for all three variants, because a
 * variant is a set of pawn rules and a start position is a condition under it.
 *
 * Run (from the repo root):
 *   bun deep-wallwars/scripts/benchmark_head_to_head.ts \
 *     --ours <our.trt> --our-samples 250 \
 *     --opp <opp.trt> --opp-samples 1 --variant standard --games 20 --seed 7 \
 *     --width 8 --height 8 --archive <file.jsonl> --experiment <name> \
 *     [--engine <path to deep_ww_bgs_engine>] [--setup random-start] \
 *     [--our-noise 0.6] [--opp-noise 0]
 */
import { appendFileSync } from "node:fs";
import { EngineProcess } from "../../official-custom-bot-client/src/engine-runner";
import {
  buildAnimalCycleInitialState,
  generateAnimalCycleRandomInitialState,
} from "../../shared/domain/animal-cycle-setup";
import { GameState } from "../../shared/domain/game-state";
import {
  buildClassicInitialState,
  generateClassicRandomInitialState,
} from "../../shared/domain/classic-setup";
import { generateStandardRandomInitialState } from "../../shared/domain/random-start-setup";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import type {
  GameConfiguration,
  Variant,
} from "../../shared/domain/game-types";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

// Default is repo-relative so this stays machine-independent; override with
// --engine when the build lives elsewhere (e.g. the GPU box).
const BGS_ENGINE = arg("engine", "deep-wallwars/build/deep_ww_bgs_engine");
const OURS = arg("ours");
const OUR_SAMPLES = parseInt(arg("our-samples", "250"), 10);
const OPP = arg("opp");
const OPP_SAMPLES = parseInt(arg("opp-samples", "1"), 10);
/**
 * Dirichlet noise mixed into each side's ROOT priors, independently.
 *
 * Per side because that is the only way to measure it. `deep_ww`'s own
 * `--root_noise_factor` is one number applied to both MCTS instances, so a
 * sweep over it moves the candidate and the reference together and the win
 * rate trends to 50% for the wrong reason. Here each side is a separate
 * process with its own command line, so the reference can stay fixed.
 *
 * At `--samples 1` this flag IS the move selection: with no tree to absorb it,
 * the engine takes the argmax of priors that are `(1-f)` policy and `f`
 * Dirichlet. So 0 is the policy's own favourite move and 1 is uniform random.
 * The engine's own default is 0.25.
 */
const OUR_NOISE = arg("our-noise", "");
const OPP_NOISE = arg("opp-noise", "");
const noiseFlag = (value: string): string =>
  value === "" ? "" : ` --root_noise_factor ${Number(value)}`;

/**
 * The share of OUR moves that come from the built-in naive policy instead of
 * the engine - the site's other difficulty knob, and the one that actually
 * ships. It lives in the bot client (`naiveMoveRates` in ws-client.ts), not in
 * any engine flag, so a benchmark that only drove engines was measuring a bot
 * the site does not serve.
 *
 * Modelled the way the client models it: a second `--model simple` process
 * kept in lockstep as a shadow, whose move is swapped in when the roll says
 * so. Same policy, same defaults, same lockstep.
 */
const OUR_NAIVE_RATE = parseFloat(arg("our-naive-rate", "0"));

/**
 * Seeded, so a rerun of the same command replays the same coin flips. Rolling
 * with Math.random would make every measurement a different experiment and
 * quietly turn a 3-point difference between two configurations into noise.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const VARIANT = arg("variant", "standard") as Variant;
const SETUP_MODE = arg("setup", "fixed");
const GAMES = parseInt(arg("games", "20"), 10);
const SEED = parseInt(arg("seed", "7"), 10);
/**
 * Where every completed game is recorded, and under which experiment name.
 *
 * Deliberately REQUIRED - `arg` throws when they are absent. A strength run
 * that archives nothing produces a win/loss number with no way to recover the
 * conditions behind it, and that number is exactly what gets quoted months
 * later. Making the flag mandatory is what stops an unarchived run existing.
 */
const ARCHIVE_FILE = arg("archive");
const EXPERIMENT = arg("experiment");
const MOVE_LIMIT = 300;
const SEND_TIMEOUT_MS = 60000;
const W = parseInt(arg("width", "8"), 10), H = parseInt(arg("height", "8"), 10);
const FAKE_TS = 0; // constant timestamp => referee never deducts clock time

if (!["standard", "classic", "animal-cycle"].includes(VARIANT)) {
  throw new Error(`unsupported benchmark variant: ${VARIANT}`);
}
if (SETUP_MODE !== "fixed" && SETUP_MODE !== "random-start") {
  throw new Error(`unsupported --setup: ${SETUP_MODE}`);
}
// Open the archive BEFORE spending GPU time. The games are appended one line
// at a time as they finish, so a bad --archive path (missing directory, no
// write permission) would otherwise surface only after the first game, having
// already burned the run. Creating the file here also means an empty archive
// afterwards reads as "ran and won nothing to record", not "never started".
appendFileSync(ARCHIVE_FILE, "");

function makeConfig(gameIdx: number): GameConfiguration {
  const randomStart = SETUP_MODE === "random-start";
  const rng = makeRng(SEED * 1_000_003 + gameIdx);
  const variantConfig =
    VARIANT === "classic"
      ? randomStart
        ? generateClassicRandomInitialState(W, H, rng)
        : buildClassicInitialState(W, H)
      : VARIANT === "animal-cycle"
        ? randomStart
          ? generateAnimalCycleRandomInitialState(W, H, rng)
          : buildAnimalCycleInitialState(W, H)
        : randomStart
          ? generateStandardRandomInitialState(W, H, rng)
          : buildStandardInitialState(W, H);
  return {
    variant: VARIANT,
    randomStart,
    timeControl: { initialSeconds: 100000, incrementSeconds: 0, preset: "rapid" },
    rated: false,
    boardWidth: W,
    boardHeight: H,
    variantConfig,
  };
}

async function send(engine: EngineProcess, req: any): Promise<any> {
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("engine send timeout")), SEND_TIMEOUT_MS),
  );
  return Promise.race([engine.send(req), timeout]) as Promise<any>;
}

// Returns "ours" | "opp" | "draw" for one game. `oursIsP1` alternates seats.
type Side = "ours" | "opp" | "draw";

interface GameOutcome {
  outcome: Side;
  reason: string;
  moves: string[];
  candidateEvaluations: number[];
  baselineEvaluations: number[];
  initialProbe: {
    candidateBestMove: string;
    baselineBestMove: string;
    candidateEvaluation: number;
    baselineEvaluation: number;
  };
  legalityErrors: string[];
  initialState: GameConfiguration["variantConfig"];
}

async function playGame(
  ours: EngineProcess,
  opp: EngineProcess,
  gameIdx: number,
  oursIsP1: boolean,
  naive: EngineProcess | null,
): Promise<GameOutcome> {
  const config = makeConfig(gameIdx);
  let referee = new GameState(config, FAKE_TS);
  const initialState = referee.getInitialState();
  const bgsConfig = { variant: VARIANT, boardWidth: W, boardHeight: H, initialState };

  // Per-engine session id; seat map by referee player id (1 or 2).
  const oursId = `g${gameIdx}-ours`;
  const oppId = `g${gameIdx}-opp`;
  const seat: Record<number, { eng: EngineProcess; bgsId: string }> = {
    [oursIsP1 ? 1 : 2]: { eng: ours, bgsId: oursId },
    [oursIsP1 ? 2 : 1]: { eng: opp, bgsId: oppId },
  };

  const naiveId = `g${gameIdx}-naive`;
  const started = await Promise.all([
    send(ours, {
      type: "start_game_session",
      bgsId: oursId,
      botId: "ours",
      config: bgsConfig,
    }),
    send(opp, {
      type: "start_game_session",
      bgsId: oppId,
      botId: "opp",
      config: bgsConfig,
    }),
  ]);
  if (started.some((response) => !response.success)) {
    throw new Error(
      `engine session start failed: ${started
        .filter((response) => !response.success)
        .map((response) => response.error)
        .join("; ")}`,
    );
  }
  if (naive) {
    await send(naive, { type: "start_game_session", bgsId: naiveId, botId: "naive", config: bgsConfig });
  }
  const initialResponses = await Promise.all([
    send(ours, { type: "evaluate_position", bgsId: oursId, expectedPly: 0 }),
    send(opp, { type: "evaluate_position", bgsId: oppId, expectedPly: 0 }),
  ]);
  if (initialResponses.some((response) => !response.success || !response.bestMove)) {
    throw new Error(
      `initial position probe failed: ${initialResponses
        .filter((response) => !response.success || !response.bestMove)
        .map((response) => response.error || "engine returned no move")
        .join("; ")}`,
    );
  }
  const [candidateInitial, baselineInitial] = initialResponses;
  const initialProbe = {
    candidateBestMove: candidateInitial.bestMove,
    baselineBestMove: baselineInitial.bestMove,
    candidateEvaluation: candidateInitial.evaluation,
    baselineEvaluation: baselineInitial.evaluation,
  };
  // One stream of coin flips per game, derived from the seed, so game 7 rolls
  // the same way whatever the noise level under test is.
  const roll = makeRng(SEED * 1000 + gameIdx);

  let outcome: Side = "draw";
  let reason = "move-limit"; // default if the loop exits via the ply cap
  const moves: string[] = [];
  const candidateEvaluations: number[] = [];
  const baselineEvaluations: number[] = [];
  const legalityErrors: string[] = [];
  // A LEGALITY PROBE, NOT A MOVE. The result of applyGameAction is discarded on
  // purpose: GameState is immutable, so `referee` is untouched and the game
  // still starts from ply 0. All this asks is "would each engine's first answer
  // be accepted?", and it asks it of BOTH engines even though only the mover
  // plays. That matters most under --setup random-start, where a generated
  // position is new every game: an engine that emits an illegal move from an
  // unusual start would otherwise show up as a loss and be read as weakness.
  for (const [label, response] of [
    ["candidate", candidateInitial],
    ["baseline", baselineInitial],
  ] as const) {
    try {
      referee.applyGameAction({
        kind: "move",
        move: moveFromStandardNotation(response.bestMove, H),
        playerId: referee.turn,
        timestamp: FAKE_TS,
      });
    } catch (error) {
      legalityErrors.push(
        `${label} initial ${response.bestMove}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    for (let ply = 0; referee.status === "playing" && ply < MOVE_LIMIT; ply++) {
      const mover = referee.turn; // 1 or 2, matches ply parity
      const me = seat[mover];
      const isOurTurn = mover === (oursIsP1 ? 1 : 2);
      let ev =
        ply === 0
          ? isOurTurn
            ? candidateInitial
            : baselineInitial
          : await send(me.eng, {
              type: "evaluate_position",
              bgsId: me.bgsId,
              expectedPly: ply,
            });
      // The naive swap, exactly as the client does it: the engine is asked
      // first and its answer is replaced. Asking it anyway is not waste - it
      // is what keeps its own tree advancing, and it is what the client does.
      if (naive && isOurTurn && ev.success && roll() < OUR_NAIVE_RATE) {
        const naiveEv = await send(naive, { type: "evaluate_position", bgsId: naiveId, expectedPly: ply });
        if (naiveEv.success && naiveEv.bestMove) ev = naiveEv;
      }
      if (!ev.success || !ev.bestMove) {
        // No legal move => mover loses.
        outcome = mover === (oursIsP1 ? 1 : 2) ? "opp" : "ours";
        reason = "no-legal-move";
        legalityErrors.push(ev.error || "engine returned no move");
        return {
          outcome,
          reason,
          moves,
          candidateEvaluations,
          baselineEvaluations,
          initialProbe,
          legalityErrors,
          initialState,
        };
      }
      (isOurTurn ? candidateEvaluations : baselineEvaluations).push(
        ev.evaluation,
      );
      moves.push(ev.bestMove);
      const move = moveFromStandardNotation(ev.bestMove, H);
      try {
        referee = referee.applyGameAction({
          kind: "move",
          move,
          playerId: mover,
          timestamp: FAKE_TS,
        });
      } catch (error) {
        outcome = mover === (oursIsP1 ? 1 : 2) ? "opp" : "ours";
        reason = "illegal-engine-move";
        legalityErrors.push(
          `${ev.bestMove}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          outcome,
          reason,
          moves,
          candidateEvaluations,
          baselineEvaluations,
          initialProbe,
          legalityErrors,
          initialState,
        };
      }
      // Advance BOTH engines to keep them in lockstep (tree reuse).
      const applied = await Promise.all([
        send(seat[1].eng, {
          type: "apply_move",
          bgsId: seat[1].bgsId,
          expectedPly: ply,
          move: ev.bestMove,
        }),
        send(seat[2].eng, {
          type: "apply_move",
          bgsId: seat[2].bgsId,
          expectedPly: ply,
          move: ev.bestMove,
        }),
      ]);
      if (applied.some((response) => !response.success)) {
        reason = "engine-apply-failure";
        legalityErrors.push(
          ...applied
            .filter((response) => !response.success)
            .map((response) => response.error || "engine rejected applied move"),
        );
        outcome = "draw";
        return {
          outcome,
          reason,
          moves,
          candidateEvaluations,
          baselineEvaluations,
          initialProbe,
          legalityErrors,
          initialState,
        };
      }
      if (naive) {
        await send(naive, { type: "apply_move", bgsId: naiveId, expectedPly: ply, move: ev.bestMove });
      }
    }
    if (referee.status === "finished" && referee.result) {
      const r = referee.result;
      reason = r.reason;
      if (r.winner === undefined) outcome = "draw";
      else outcome = r.winner === (oursIsP1 ? 1 : 2) ? "ours" : "opp";
    }
  } finally {
    await send(ours, { type: "end_game_session", bgsId: oursId }).catch(() => {});
    await send(opp, { type: "end_game_session", bgsId: oppId }).catch(() => {});
    if (naive) {
      await send(naive, { type: "end_game_session", bgsId: naiveId }).catch(() => {});
    }
  }
  return {
    outcome,
    reason,
    moves,
    candidateEvaluations,
    baselineEvaluations,
    initialProbe,
    legalityErrors,
    initialState,
  };
}

async function main() {
  const ours = await EngineProcess.spawn(
    `${BGS_ENGINE} --model ${OURS} --samples ${OUR_SAMPLES} --seed ${SEED}${noiseFlag(OUR_NOISE)}`,
    "benchmark-candidate",
  );
  const opp = await EngineProcess.spawn(
    `${BGS_ENGINE} --model ${OPP} --samples ${OPP_SAMPLES} --seed ${SEED}${noiseFlag(OPP_NOISE)}`,
    "benchmark-baseline",
  );
  // Only spawned when asked for: a third GPU process per run is not free, and
  // a rate of 0 must measure exactly what it measured before this flag existed.
  const naive =
    OUR_NAIVE_RATE > 0
      ? await EngineProcess.spawn(
          `${BGS_ENGINE} --model simple --samples 1 --seed ${SEED} --root_noise_factor 0`,
          "benchmark-naive",
        )
      : null;
  const tally = { ours: 0, opp: 0, draw: 0 };
  // Per-seat: when our model is P1 (red/first) vs P2 (blue/second).
  const bySeat = { P1: { ours: 0, opp: 0, draw: 0 }, P2: { ours: 0, opp: 0, draw: 0 } };
  const reasons: Record<string, number> = {};
  let legalGames = 0;
  const valueSignal = {
    pairedInitialPositions: 0,
    initialTopMoveAgreements: 0,
    candidateInitialSum: 0,
    baselineInitialSum: 0,
    absoluteInitialDifferenceSum: 0,
    candidateMoverPositions: 0,
    candidateMoverEvaluationSum: 0,
    baselineMoverPositions: 0,
    baselineMoverEvaluationSum: 0,
  };
  // --dump now records EVERY game, not only the draws it was added to inspect.
  // The archive is the durable per-game record; this stays as the human-readable
  // one, and a draws-only file cannot answer "what did the other games look
  // like" without a second run under different conditions.
  const dumpFile = process.argv.includes("--dump") ? arg("dump") : null;
  const dumped: any[] = [];
  try {
    for (let g = 0; g < GAMES; g++) {
      const oursIsP1 = g % 2 === 0;
      const game = await playGame(ours, opp, g, oursIsP1, naive);
      const { outcome: res, reason, moves } = game;
      tally[res]++;
      bySeat[oursIsP1 ? "P1" : "P2"][res]++;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (game.legalityErrors.length === 0) legalGames++;
      valueSignal.pairedInitialPositions++;
      if (
        game.initialProbe.candidateBestMove ===
        game.initialProbe.baselineBestMove
      ) {
        valueSignal.initialTopMoveAgreements++;
      }
      valueSignal.candidateInitialSum +=
        game.initialProbe.candidateEvaluation;
      valueSignal.baselineInitialSum += game.initialProbe.baselineEvaluation;
      valueSignal.absoluteInitialDifferenceSum += Math.abs(
        game.initialProbe.candidateEvaluation -
          game.initialProbe.baselineEvaluation,
      );
      for (const evaluation of game.candidateEvaluations) {
        valueSignal.candidateMoverPositions++;
        valueSignal.candidateMoverEvaluationSum += evaluation;
      }
      for (const evaluation of game.baselineEvaluations) {
        valueSignal.baselineMoverPositions++;
        valueSignal.baselineMoverEvaluationSum += evaluation;
      }
      if (dumpFile) {
        dumped.push({
          game: g,
          seed: SEED * 1_000_003 + g,
          oursIsP1,
          outcome: res,
          reason,
          plies: moves.length,
          moves,
          candidateEvaluations: game.candidateEvaluations,
          baselineEvaluations: game.baselineEvaluations,
          initialProbe: game.initialProbe,
          legalityErrors: game.legalityErrors,
          initialState: game.initialState,
        });
      }
      const candidateIsP1 = oursIsP1;
      const whiteModel = candidateIsP1 ? OURS : OPP;
      const blackModel = candidateIsP1 ? OPP : OURS;
      const result =
        res === "draw"
          ? "1/2-1/2"
          : (res === "ours") === candidateIsP1
            ? "1-0"
            : "0-1";
      appendFileSync(
        ARCHIVE_FILE,
        `${JSON.stringify({
          format: "wallgame-engine-strength-game-v1",
          exp: EXPERIMENT,
          variant: VARIANT,
          setup: SETUP_MODE,
          board: `${W}x${H}`,
          game: g,
          engineSeed: SEED,
          randomStartSeed: SEED * 1_000_003 + g,
          whiteModel,
          blackModel,
          candidateModel: OURS,
          baselineModel: OPP,
          candidateIsP1,
          result,
          outcome: res,
          reason,
          plies: moves.length,
          moves,
          candidateEvaluations: game.candidateEvaluations,
          baselineEvaluations: game.baselineEvaluations,
          initialProbe: game.initialProbe,
          legalityErrors: game.legalityErrors,
          initialState: game.initialState,
        })}\n`,
      );
      console.error(`game ${g} (ours ${oursIsP1 ? "P1" : "P2"}): ${res} [${reason}, ${moves.length} plies]  [W/L/D ${tally.ours}/${tally.opp}/${tally.draw}]`);
    }
    if (dumpFile) { await Bun.write(dumpFile, JSON.stringify(dumped, null, 1)); }
    console.error("termination reasons:", JSON.stringify(reasons));
  } finally {
    ours.kill();
    opp.kill();
    naive?.kill();
  }
  console.log(JSON.stringify({
    variant: VARIANT, setup: SETUP_MODE, width: W, height: H,
    seed: SEED, ours: OURS.split("/").pop(), our_samples: OUR_SAMPLES,
    our_noise: OUR_NOISE === "" ? "(engine default)" : Number(OUR_NOISE),
    our_naive_rate: OUR_NAIVE_RATE,
    opp: OPP.split("/").pop(), opp_samples: OPP_SAMPLES,
    opp_noise: OPP_NOISE === "" ? "(engine default)" : Number(OPP_NOISE),
    games: GAMES,
    wld: `${tally.ours}/${tally.opp}/${tally.draw}`, tally,
    legality: { legal_games: legalGames, illegal_games: GAMES - legalGames },
    value_signal: {
      paired_initial_positions: valueSignal.pairedInitialPositions,
      initial_top_move_agreement_rate:
        valueSignal.initialTopMoveAgreements /
        valueSignal.pairedInitialPositions,
      candidate_mean_initial_p1_evaluation:
        valueSignal.candidateInitialSum /
        valueSignal.pairedInitialPositions,
      baseline_mean_initial_p1_evaluation:
        valueSignal.baselineInitialSum /
        valueSignal.pairedInitialPositions,
      mean_absolute_initial_evaluation_difference:
        valueSignal.absoluteInitialDifferenceSum /
        valueSignal.pairedInitialPositions,
      candidate_mover_positions: valueSignal.candidateMoverPositions,
      candidate_mean_mover_p1_evaluation:
        valueSignal.candidateMoverEvaluationSum /
        valueSignal.candidateMoverPositions,
      baseline_mover_positions: valueSignal.baselineMoverPositions,
      baseline_mean_mover_p1_evaluation:
        valueSignal.baselineMoverEvaluationSum /
        valueSignal.baselineMoverPositions,
    },
    policy_only:
      OUR_SAMPLES === 1 && OPP_SAMPLES === 1 && OUR_NOISE === "0" && OPP_NOISE === "0",
    our_wld_as_P1_red: `${bySeat.P1.ours}/${bySeat.P1.opp}/${bySeat.P1.draw}`,
    our_wld_as_P2_blue: `${bySeat.P2.ours}/${bySeat.P2.opp}/${bySeat.P2.draw}`,
  }));
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
