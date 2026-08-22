/** Run one frozen policy-Elo window through long-lived per-generation engines. */

import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
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
  GameInitialState,
  Variant,
} from "../../shared/domain/game-types";

interface Pairing {
  conditionId: string;
  variant: Variant;
  setup: "fixed" | "random-start";
  width: number;
  height: number;
  generationA: number;
  generationB: number;
  existingAcceptedGames: number;
  games: number;
  windowId: string;
}

interface Window {
  id: string;
  generations: number[];
  engineSeed: number;
}

interface Plan {
  experiment: string;
  engine: { path: string; sha256: string };
  models: Record<string, { path: string; sha256: string }>;
  pairings: Pairing[];
  windows: Window[];
}

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function requirePinnedFile(path: string, expected: string, label: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 differs: expected ${expected}, got ${actual}`);
  }
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function initialConfig(pairing: Pairing, randomStartSeed: number): GameConfiguration {
  const randomStart = pairing.setup === "random-start";
  const rng = makeRng(randomStartSeed);
  const variantConfig =
    pairing.variant === "classic"
      ? randomStart
        ? generateClassicRandomInitialState(pairing.width, pairing.height, rng)
        : buildClassicInitialState(pairing.width, pairing.height)
      : pairing.variant === "animal-cycle"
        ? randomStart
          ? generateAnimalCycleRandomInitialState(pairing.width, pairing.height, rng)
          : buildAnimalCycleInitialState(pairing.width, pairing.height)
        : randomStart
          ? generateStandardRandomInitialState(pairing.width, pairing.height, rng)
          : buildStandardInitialState(pairing.width, pairing.height);
  return {
    variant: pairing.variant,
    randomStart,
    timeControl: { initialSeconds: 100000, incrementSeconds: 0, preset: "rapid" },
    rated: false,
    boardWidth: pairing.width,
    boardHeight: pairing.height,
    variantConfig,
  };
}

const SEND_TIMEOUT_MS = 60_000;
const MOVE_LIMIT = 300;
const FAKE_TIMESTAMP = 0;

async function send(engine: EngineProcess, request: any): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      engine.send(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("engine send timeout")), SEND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function gameIdentity(
  experiment: string,
  pairing: Pairing,
  gameIndex: number,
): string {
  return hash(
    [
      experiment,
      pairing.conditionId,
      pairing.generationA,
      pairing.generationB,
      gameIndex,
    ].join("\0"),
  );
}

function randomStartSeed(identity: string): number {
  return Number.parseInt(identity.slice(0, 8), 16) & 0x7fffffff;
}

export class RawJournal {
  private readonly fd: number;
  private readonly failureFd: number;
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly root: string,
    attempt: string,
  ) {
    mkdirSync(root, { recursive: true });
    for (const name of readdirSync(root).filter((value) => value.endsWith(".jsonl"))) {
      const path = join(root, name);
      const contents = readFileSync(path);
      const finalNewline = contents.lastIndexOf(0x0a);
      const complete = finalNewline < 0 ? Buffer.alloc(0) : contents.subarray(0, finalNewline + 1);
      const tail = contents.subarray(finalNewline + 1);
      if (tail.length > 0) this.preserveTornTail(path, tail);
      for (const line of complete.toString("utf8").split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as { gameId?: string; accepted?: boolean };
        if (!row.gameId) throw new Error(`raw row lacks gameId: ${path}`);
        if (typeof row.accepted !== "boolean") {
          throw new Error(`raw row lacks boolean accepted status: ${path}`);
        }
        const rowHash = hash(line);
        if (!row.accepted) {
          this.preserveFailedRow(row.gameId, rowHash, line);
          continue;
        }
        const priorHash = this.seen.get(row.gameId);
        if (priorHash && priorHash !== rowHash) {
          throw new Error(`conflicting raw gameId: ${row.gameId}`);
        }
        this.seen.set(row.gameId, rowHash);
      }
    }
    this.fd = openSync(join(root, `${attempt}.jsonl`), "ax");
    const failuresRoot = join(root, "failures");
    mkdirSync(failuresRoot, { recursive: true });
    this.failureFd = openSync(join(failuresRoot, `${attempt}.jsonl`), "ax");
  }

  private preserveFailedRow(gameId: string, rowHash: string, line: string): void {
    const failuresRoot = join(this.root, "failures", "recovered");
    mkdirSync(failuresRoot, { recursive: true });
    const target = join(failuresRoot, `${gameId}.${rowHash}.json`);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== `${line}\n`) {
        throw new Error(`recovered failure artifact differs: ${target}`);
      }
      return;
    }
    const fd = openSync(target, "wx");
    try {
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private preserveTornTail(path: string, tail: Buffer): void {
    const tornRoot = join(this.root, "torn");
    mkdirSync(tornRoot, { recursive: true });
    const tailHash = hash(tail.toString("base64"));
    const target = join(tornRoot, `${basename(path)}.${tailHash}.tail`);
    if (existsSync(target)) {
      if (!readFileSync(target).equals(tail)) {
        throw new Error(`torn-tail artifact differs: ${target}`);
      }
      return;
    }
    const fd = openSync(target, "wx");
    try {
      writeSync(fd, tail);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  has(gameId: string): boolean {
    return this.seen.has(gameId);
  }

  append(row: Record<string, unknown>): void {
    const gameId = row.gameId;
    const accepted = row.accepted;
    if (typeof gameId !== "string" || typeof accepted !== "boolean") {
      throw new Error(`invalid game row: ${String(gameId)}`);
    }
    if (accepted && this.seen.has(gameId)) {
      throw new Error(`invalid or duplicate gameId: ${String(gameId)}`);
    }
    const payload = `${JSON.stringify(row)}\n`;
    const targetFd = accepted ? this.fd : this.failureFd;
    writeSync(targetFd, payload);
    fsyncSync(targetFd);
    if (accepted) this.seen.set(gameId, hash(payload.slice(0, -1)));
  }

  acceptedIds(): Set<string> {
    return new Set(this.seen.keys());
  }

  close(): void {
    closeSync(this.fd);
    closeSync(this.failureFd);
  }
}

export function assertExpectedAccepted(raw: RawJournal, expected: Set<string>): void {
  const actual = raw.acceptedIds();
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length || extra.length) {
    throw new Error(
      `accepted game ID set differs: missing=${missing.length} extra=${extra.length}`,
    );
  }
}

export function writeCompletion(
  path: string,
  record: Record<string, unknown>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function playGame(
  plan: Plan,
  pairing: Pairing,
  gameIndex: number,
  engines: Map<number, EngineProcess>,
): Promise<Record<string, unknown>> {
  const id = gameIdentity(plan.experiment, pairing, gameIndex);
  const startSeed = pairing.setup === "random-start" ? randomStartSeed(id) : 0;
  const config = initialConfig(pairing, startSeed);
  let referee = new GameState(config, FAKE_TIMESTAMP);
  const initialState = referee.getInitialState();
  const initialStateSha256 = hash(JSON.stringify(initialState));
  const generationAIsP1 = gameIndex % 2 === 0;
  const p1Generation = generationAIsP1 ? pairing.generationA : pairing.generationB;
  const p2Generation = generationAIsP1 ? pairing.generationB : pairing.generationA;
  const p1 = engines.get(p1Generation);
  const p2 = engines.get(p2Generation);
  if (!p1 || !p2) throw new Error(`window lacks endpoint for ${id}`);
  const bgsIdP1 = `${id}-p1`;
  const bgsIdP2 = `${id}-p2`;
  const bgsConfig = {
    variant: pairing.variant,
    boardWidth: pairing.width,
    boardHeight: pairing.height,
    initialState,
  };
  const moves: string[] = [];
  let reason = "move-limit";
  let winner: "p1" | "p2" | "draw" = "draw";
  let failure: string | null = null;

  try {
    const started = await Promise.all([
      send(p1, { type: "start_game_session", bgsId: bgsIdP1, botId: `g${p1Generation}`, config: bgsConfig }),
      send(p2, { type: "start_game_session", bgsId: bgsIdP2, botId: `g${p2Generation}`, config: bgsConfig }),
    ]);
    if (started.some((response) => !response.success)) {
      throw new Error("engine session start failed");
    }
    for (let ply = 0; referee.status === "playing" && ply < MOVE_LIMIT; ply++) {
      const mover = referee.turn;
      const engine = mover === 1 ? p1 : p2;
      const bgsId = mover === 1 ? bgsIdP1 : bgsIdP2;
      const evaluated = await send(engine, {
        type: "evaluate_position",
        bgsId,
        expectedPly: ply,
      });
      if (!evaluated.success || !evaluated.bestMove) {
        reason = "no-legal-move";
        failure = evaluated.error || "engine returned no move";
        break;
      }
      const notation = evaluated.bestMove as string;
      try {
        referee = referee.applyGameAction({
          kind: "move",
          move: moveFromStandardNotation(notation, pairing.height),
          playerId: mover,
          timestamp: FAKE_TIMESTAMP,
        });
      } catch (error) {
        reason = "illegal-engine-move";
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
      moves.push(notation);
      const applied = await Promise.all([
        send(p1, { type: "apply_move", bgsId: bgsIdP1, expectedPly: ply, move: notation }),
        send(p2, { type: "apply_move", bgsId: bgsIdP2, expectedPly: ply, move: notation }),
      ]);
      if (applied.some((response) => !response.success)) {
        reason = "engine-apply-failure";
        failure = applied.find((response) => !response.success)?.error || "apply failed";
        break;
      }
    }
    if (!failure && referee.status === "finished" && referee.result) {
      reason = referee.result.reason;
      winner =
        referee.result.winner === undefined
          ? "draw"
          : referee.result.winner === 1
            ? "p1"
            : "p2";
    }
  } finally {
    await Promise.allSettled([
      send(p1, { type: "end_game_session", bgsId: bgsIdP1 }),
      send(p2, { type: "end_game_session", bgsId: bgsIdP2 }),
    ]);
  }

  return {
    schema: "wallgame-policy-elo-raw-game-v1",
    experiment: plan.experiment,
    settings: "samples=1;rootNoiseFactor=0;moveSelection=policy-argmax",
    conditionId: pairing.conditionId,
    variant: pairing.variant,
    setup: pairing.setup,
    boardWidth: pairing.width,
    boardHeight: pairing.height,
    gameId: id,
    gameIndex,
    p1Generation,
    p2Generation,
    winner,
    reason,
    plies: moves.length,
    engineSeed: plan.windows.find((window) => window.id === pairing.windowId)?.engineSeed,
    randomStartSeed: pairing.setup === "random-start" ? startSeed : null,
    initialStateSha256,
    initialState: initialState as GameInitialState,
    moves,
    failure,
    accepted: failure === null,
  };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("shutdown timeout")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const planPath = resolve(arg("plan"));
  const windowId = arg("window");
  const runRoot = resolve(arg("run-root"));
  const attempt = arg("attempt");
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  const window = plan.windows.find((candidate) => candidate.id === windowId);
  if (!window) throw new Error(`unknown window: ${windowId}`);
  if (new Set(plan.windows.map((candidate) => candidate.id)).size !== plan.windows.length) {
    throw new Error("plan has duplicate window IDs");
  }
  if (window.generations.length > 8) throw new Error("window exceeds eight resident models");
  if (window.generations.length < 2 || new Set(window.generations).size !== window.generations.length) {
    throw new Error("window generations are invalid or duplicated");
  }
  const pairings = plan.pairings.filter((pairing) => pairing.windowId === windowId);
  const completionPath = join(runRoot, "completions", `${windowId}.${attempt}.json`);
  if (existsSync(completionPath)) {
    throw new Error(`completion output already exists: ${completionPath}`);
  }
  if (pairings.length === 0) throw new Error("window has no pairings");
  const pairingKeys = new Set<string>();
  for (const pairing of pairings) {
    if (
      pairing.generationA >= pairing.generationB ||
      !window.generations.includes(pairing.generationA) ||
      !window.generations.includes(pairing.generationB)
    ) {
      throw new Error(`invalid pairing endpoints in ${pairing.conditionId}`);
    }
    const key = `${pairing.conditionId}\0${pairing.generationA}\0${pairing.generationB}`;
    if (pairingKeys.has(key)) throw new Error(`duplicate window pairing: ${key}`);
    pairingKeys.add(key);
  }
  await requirePinnedFile(plan.engine.path, plan.engine.sha256, "engine");
  for (const generation of window.generations) {
    const model = plan.models[String(generation)];
    if (!model) throw new Error(`plan lacks model ${generation}`);
    await requirePinnedFile(model.path, model.sha256, `model ${generation}`);
  }

  const raw = new RawJournal(join(runRoot, "raw", windowId), attempt);
  const expectedAccepted = new Set<string>();
  for (const pairing of pairings) {
    for (let offset = 0; offset < pairing.games; offset++) {
      expectedAccepted.add(
        gameIdentity(plan.experiment, pairing, pairing.existingAcceptedGames + offset),
      );
    }
  }
  const statsRoot = join(runRoot, "batch-stats", windowId, attempt);
  mkdirSync(statsRoot, { recursive: true });
  const engines = new Map<number, EngineProcess>();
  const batchStats: Record<string, unknown>[] = [];
  try {
    for (const generation of window.generations) {
      const model = plan.models[String(generation)];
      if (!model) throw new Error(`plan lacks model ${generation}`);
      const stats = join(statsRoot, `model_${generation}.json`);
      if (existsSync(stats)) throw new Error(`stats output already exists: ${stats}`);
      engines.set(
        generation,
        await EngineProcess.spawn(
          `${plan.engine.path} --model ${model.path} --samples 1 --parallel_samples 32 ` +
            `--thread_pool_size 12 --root_noise_factor 0 --seed ${window.engineSeed} ` +
            `--batch_stats_output ${stats}`,
          `${windowId}-g${generation}`,
        ),
      );
    }

    const conditionIds = [...new Set(pairings.map((pairing) => pairing.conditionId))].sort();
    for (const conditionId of conditionIds) {
      const tasks: Promise<Record<string, unknown>>[] = [];
      for (const pairing of pairings.filter((item) => item.conditionId === conditionId)) {
        for (let offset = 0; offset < pairing.games; offset++) {
          const gameIndex = pairing.existingAcceptedGames + offset;
          const id = gameIdentity(plan.experiment, pairing, gameIndex);
          if (!raw.has(id)) {
            tasks.push(
              playGame(plan, pairing, gameIndex, engines).then((row) => {
                raw.append(row);
                if (row.accepted !== true) {
                  throw new Error(`game failed integrity: ${String(row.gameId)}`);
                }
                return row;
              }),
            );
          }
        }
      }
      const settled = await Promise.allSettled(tasks);
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected) throw rejected.reason;
    }

    for (const [generation, engine] of engines) {
      try {
        await withTimeout(engine.shutdown(), 60_000);
      } catch (error) {
        engine.kill();
        throw new Error(
          `model ${generation} did not shut down cleanly: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const generation of window.generations) {
      const path = join(statsRoot, `model_${generation}.json`);
      if (!existsSync(path)) throw new Error(`model ${generation} lacks batch stats`);
      const stats = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (
        stats.schema !== "wallgame-bgs-batch-stats-v1" ||
        typeof stats.inferences !== "number" ||
        stats.inferences <= 0 ||
        typeof stats.batches !== "number" ||
        stats.batches <= 0 ||
        typeof stats.inferencesPerBatch !== "number" ||
        !Number.isFinite(stats.inferencesPerBatch) ||
        stats.inferencesPerBatch <= 0
      ) {
        throw new Error(`model ${generation} has invalid batch stats`);
      }
      batchStats.push({
        generation,
        path,
        sha256: await sha256File(path),
        inferences: stats.inferences,
        batches: stats.batches,
        inferencesPerBatch: stats.inferencesPerBatch,
      });
    }
    assertExpectedAccepted(raw, expectedAccepted);
  } finally {
    for (const engine of engines.values()) engine.kill();
    raw.close();
  }
  // This is the only success marker. A launcher EXIT trap can record diagnostic
  // status, but it must never claim completion: SIGINT, SIGTERM, a thrown error,
  // or a killed engine cannot reach this fail-if-existing durable write.
  writeCompletion(completionPath, {
    schema: "wallgame-policy-elo-window-completion-v1",
    experiment: plan.experiment,
    window: windowId,
    attempt,
    pairings: pairings.length,
    batchStats,
  });
  console.log(JSON.stringify({ window: windowId, pairings: pairings.length }));
}

if (import.meta.main) await main();
