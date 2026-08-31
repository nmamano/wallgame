import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildOrdinaryInitialState } from "../../shared/domain/game-configuration";
import type { RulesVariant } from "../../shared/domain/game-types";

export type TrainingInitialStateRecord = {
  gameIndex: number;
  seed: number;
  gameSeed: number;
  variant: RulesVariant;
  boardWidth: number;
  boardHeight: number;
  dimensionMode: "low" | "high" | "random";
  startMode: "traditional" | "random";
  initialState: ReturnType<typeof buildOrdinaryInitialState>;
  replacementOfGameIndex?: number;
  replacementAttempt?: number;
  replacementIdentity?: string;
};

export type TrainingReplacementRequest = {
  sourceRecord: TrainingInitialStateRecord;
  replacementAttempt: number;
  gameIndex: number;
};

export const makeTrainingRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

export const trainingGameSeed = (seed: number, gameIndex: number): number => {
  let mixed = (seed ^ Math.imul(gameIndex, 0x9e3779b1)) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
};

export const replacementGameSeed = (
  seed: number,
  sourceGameIndex: number,
  replacementAttempt: number,
): number => {
  const identity = Math.imul(sourceGameIndex, 0x9e3779b1) ^ Math.imul(replacementAttempt, 0x85ebca6b);
  return trainingGameSeed(seed ^ 0xc2b2ae35, identity >>> 0);
};

const inclusiveInteger = (rng: () => number, low: number, high: number) =>
  low + Math.floor(rng() * (high - low + 1));

const sampleDimensions = (
  variant: RulesVariant,
  rng: () => number,
): readonly [number, number, TrainingInitialStateRecord["dimensionMode"]] => {
  const branch = Math.floor(rng() * 3);
  if (variant === "animal-cycle") {
    if (branch === 0) return [7, 7, "low"];
    if (branch === 1) return [9, 9, "high"];
    return [inclusiveInteger(rng, 7, 12), inclusiveInteger(rng, 7, 10), "random"];
  }
  if (branch === 0) return [8, 8, "low"];
  if (branch === 1) return [12, 10, "high"];
  return [inclusiveInteger(rng, 8, 12), inclusiveInteger(rng, 8, 10), "random"];
};

export const sampleTrainingInitialStates = (
  seed: number,
  games: number,
  startGame = 1,
): TrainingInitialStateRecord[] => {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("seed must be a non-negative integer");
  if (!Number.isSafeInteger(games) || games < 1) throw new Error("games must be a positive integer");
  if (!Number.isSafeInteger(startGame) || startGame < 1) throw new Error("startGame must be positive");

  const variants: RulesVariant[] = ["standard", "classic", "animal-cycle"];
  return Array.from({ length: games }, (_, offset) => {
    const gameIndex = startGame + offset;
    const gameSeed = trainingGameSeed(seed, gameIndex);
    const rng = makeTrainingRng(gameSeed);
    const variant = variants[Math.floor(rng() * variants.length)];
    const [boardWidth, boardHeight, dimensionMode] = sampleDimensions(variant, rng);
    const randomStart = rng() < 0.5;
    return {
      gameIndex,
      seed,
      gameSeed,
      variant,
      boardWidth,
      boardHeight,
      dimensionMode,
      startMode: randomStart ? "random" : "traditional",
      initialState: buildOrdinaryInitialState(
        { variant, randomStart, boardWidth, boardHeight },
        rng,
      ),
    };
  });
};

export const sampleReplacementInitialState = (
  seed: number,
  request: TrainingReplacementRequest,
): TrainingInitialStateRecord => {
  const { sourceRecord, replacementAttempt, gameIndex } = request;
  if (!Number.isSafeInteger(gameIndex) || gameIndex < 1) throw new Error("replacement gameIndex must be positive");
  if (!Number.isSafeInteger(replacementAttempt) || replacementAttempt < 1) {
    throw new Error("replacementAttempt must be positive");
  }
  if (sourceRecord.replacementOfGameIndex !== undefined) {
    throw new Error("replacement source must be an original game");
  }
  const gameSeed = replacementGameSeed(seed, sourceRecord.gameIndex, replacementAttempt);
  const rng = makeTrainingRng(gameSeed);
  const randomStart = sourceRecord.startMode === "random";
  return {
    gameIndex,
    seed,
    gameSeed,
    variant: sourceRecord.variant,
    boardWidth: sourceRecord.boardWidth,
    boardHeight: sourceRecord.boardHeight,
    dimensionMode: sourceRecord.dimensionMode,
    startMode: sourceRecord.startMode,
    initialState: buildOrdinaryInitialState(
      {
        variant: sourceRecord.variant,
        randomStart,
        boardWidth: sourceRecord.boardWidth,
        boardHeight: sourceRecord.boardHeight,
      },
      rng,
    ),
    replacementOfGameIndex: sourceRecord.gameIndex,
    replacementAttempt,
    replacementIdentity: `${sourceRecord.gameIndex}:${replacementAttempt}`,
  };
};

const arg = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing --${name}`);
  return process.argv[index + 1];
};

if (import.meta.main) {
  const seed = Number(arg("seed"));
  const output = arg("output");
  const replacementIndex = process.argv.indexOf("--replacement-requests");
  const records = replacementIndex >= 0
    ? readFileSync(process.argv[replacementIndex + 1], "utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => sampleReplacementInitialState(seed, JSON.parse(line)))
    : sampleTrainingInitialStates(seed, Number(arg("games")), Number(arg("start-game")));
  const contents = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  if (existsSync(output)) {
    if (readFileSync(output, "utf8") !== contents) {
      throw new Error(`existing initial-state batch differs: ${output}`);
    }
  } else {
    writeFileSync(output, contents, { flag: "wx" });
  }
}
