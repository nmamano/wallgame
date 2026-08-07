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
 * Run (from the repo root):
 *   bun deep-wallwars/scripts/benchmark_head_to_head.ts \
 *     --ours <our.trt> --our-samples 250 \
 *     --opp <opp.trt> --opp-samples 1 --variant standard --games 20 --seed 7 \
 *     --width 8 --height 8 [--engine <path to deep_ww_bgs_engine>] \
 *     [--our-noise 0.6] [--opp-noise 0]
 */
import { EngineProcess } from "../../official-custom-bot-client/src/engine-runner";
import { GameState } from "../../shared/domain/game-state";
import { buildClassicInitialState } from "../../shared/domain/classic-setup";
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
const GAMES = parseInt(arg("games", "20"), 10);
const SEED = parseInt(arg("seed", "7"), 10);
const MOVE_LIMIT = 300;
const SEND_TIMEOUT_MS = 60000;
const W = parseInt(arg("width", "8"), 10), H = parseInt(arg("height", "8"), 10);
const FAKE_TS = 0; // constant timestamp => referee never deducts clock time

function makeConfig(): GameConfiguration {
  const variantConfig =
    VARIANT === "classic" ? buildClassicInitialState(W, H) : buildStandardInitialState(W, H);
  return {
    variant: VARIANT,
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
}

async function playGame(
  ours: EngineProcess,
  opp: EngineProcess,
  gameIdx: number,
  oursIsP1: boolean,
  naive: EngineProcess | null,
): Promise<GameOutcome> {
  const config = makeConfig();
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
  await send(ours, { type: "start_game_session", bgsId: oursId, botId: "ours", config: bgsConfig });
  await send(opp, { type: "start_game_session", bgsId: oppId, botId: "opp", config: bgsConfig });
  if (naive) {
    await send(naive, { type: "start_game_session", bgsId: naiveId, botId: "naive", config: bgsConfig });
  }
  // One stream of coin flips per game, derived from the seed, so game 7 rolls
  // the same way whatever the noise level under test is.
  const roll = makeRng(SEED * 1000 + gameIdx);

  let outcome: Side = "draw";
  let reason = "move-limit"; // default if the loop exits via the ply cap
  const moves: string[] = [];
  try {
    for (let ply = 0; referee.status === "playing" && ply < MOVE_LIMIT; ply++) {
      const mover = referee.turn; // 1 or 2, matches ply parity
      const me = seat[mover];
      const isOurTurn = mover === (oursIsP1 ? 1 : 2);
      let ev = await send(me.eng, { type: "evaluate_position", bgsId: me.bgsId, expectedPly: ply });
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
        return { outcome, reason, moves };
      }
      moves.push(ev.bestMove);
      const move = moveFromStandardNotation(ev.bestMove, H);
      referee = referee.applyGameAction({ kind: "move", move, playerId: mover, timestamp: FAKE_TS });
      // Advance BOTH engines to keep them in lockstep (tree reuse).
      await send(seat[1].eng, { type: "apply_move", bgsId: seat[1].bgsId, expectedPly: ply, move: ev.bestMove });
      await send(seat[2].eng, { type: "apply_move", bgsId: seat[2].bgsId, expectedPly: ply, move: ev.bestMove });
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
  return { outcome, reason, moves };
}

async function main() {
  const ours = await EngineProcess.spawn(`${BGS_ENGINE} --model ${OURS} --samples ${OUR_SAMPLES} --seed ${SEED}${noiseFlag(OUR_NOISE)}`);
  const opp = await EngineProcess.spawn(`${BGS_ENGINE} --model ${OPP} --samples ${OPP_SAMPLES} --seed ${SEED}${noiseFlag(OPP_NOISE)}`);
  // Only spawned when asked for: a third GPU process per run is not free, and
  // a rate of 0 must measure exactly what it measured before this flag existed.
  const naive =
    OUR_NAIVE_RATE > 0
      ? await EngineProcess.spawn(`${BGS_ENGINE} --model simple --samples 1 --seed ${SEED} --root_noise_factor 0`)
      : null;
  const tally = { ours: 0, opp: 0, draw: 0 };
  // Per-seat: when our model is P1 (red/first) vs P2 (blue/second).
  const bySeat = { P1: { ours: 0, opp: 0, draw: 0 }, P2: { ours: 0, opp: 0, draw: 0 } };
  const reasons: Record<string, number> = {};
  const dumpFile = process.argv.includes("--dump") ? arg("dump") : null;
  const dumped: any[] = [];
  try {
    for (let g = 0; g < GAMES; g++) {
      const oursIsP1 = g % 2 === 0;
      const { outcome: res, reason, moves } = await playGame(ours, opp, g, oursIsP1, naive);
      tally[res]++;
      bySeat[oursIsP1 ? "P1" : "P2"][res]++;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (dumpFile && res === "draw") {
        dumped.push({ game: g, oursIsP1, outcome: res, reason, plies: moves.length, moves });
      }
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
    variant: VARIANT, ours: OURS.split("/").pop(), our_samples: OUR_SAMPLES,
    our_noise: OUR_NOISE === "" ? "(engine default)" : Number(OUR_NOISE),
    our_naive_rate: OUR_NAIVE_RATE,
    opp: OPP.split("/").pop(), opp_samples: OPP_SAMPLES,
    opp_noise: OPP_NOISE === "" ? "(engine default)" : Number(OPP_NOISE),
    games: GAMES,
    wld: `${tally.ours}/${tally.opp}/${tally.draw}`, tally,
    our_wld_as_P1_red: `${bySeat.P1.ours}/${bySeat.P1.opp}/${bySeat.P1.draw}`,
    our_wld_as_P2_blue: `${bySeat.P2.ours}/${bySeat.P2.opp}/${bySeat.P2.draw}`,
  }));
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
