import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  buildAnimalCycleInitialState,
  generateAnimalCycleRandomInitialState,
} from "../../shared/domain/animal-cycle-setup";

type SetupMode = "fixed" | "random-start";

const seededRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const sha256 = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
};

const parseArgs = (): { binary: string; output: string } => {
  const binaryIndex = Bun.argv.indexOf("--binary");
  const outputIndex = Bun.argv.indexOf("--output");
  if (binaryIndex < 0 || outputIndex < 0) {
    throw new Error("Usage: bun generate_animal_cycle_cpu_corpus.ts --binary PATH --output DIR");
  }
  return {
    binary: resolve(Bun.argv[binaryIndex + 1]),
    output: resolve(Bun.argv[outputIndex + 1]),
  };
};

const { binary, output } = parseArgs();
const cases: { name: string; width: number; height: number; seed: number; setupMode: SetupMode }[] = [
  { name: "fixed-5x5", width: 5, height: 5, seed: 5101, setupMode: "fixed" },
  { name: "random-5x5", width: 5, height: 5, seed: 5102, setupMode: "random-start" },
  { name: "fixed-8x8", width: 8, height: 8, seed: 8101, setupMode: "fixed" },
  { name: "random-12x10", width: 12, height: 10, seed: 12101, setupMode: "random-start" },
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const manifestCases = [];
for (const corpusCase of cases) {
  const caseDir = join(output, corpusCase.name);
  const dataDir = join(caseDir, "data");
  await mkdir(dataDir, { recursive: true });
  const initialState =
    corpusCase.setupMode === "fixed"
      ? buildAnimalCycleInitialState(corpusCase.width, corpusCase.height)
      : generateAnimalCycleRandomInitialState(
          corpusCase.width,
          corpusCase.height,
          seededRng(corpusCase.seed),
        );
  const config = {
    variant: "animal-cycle" as const,
    setupMode: corpusCase.setupMode,
    boardWidth: corpusCase.width,
    boardHeight: corpusCase.height,
    initialState,
  };
  const configPath = join(caseDir, "config.json");
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const command = [
    binary,
    "-model1", "simple",
    "-variant", "animal-cycle",
    "-columns", String(corpusCase.width),
    "-rows", String(corpusCase.height),
    "-initial_state_config", configPath,
    "-output", dataDir,
    "-games", "1",
    "-samples", "1",
    "-move_limit", "6",
    "-j", "1",
    "-seed", String(corpusCase.seed),
  ];
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  await Bun.write(join(caseDir, "stdout.log"), result.stdout);
  await Bun.write(join(caseDir, "stderr.log"), result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`${corpusCase.name} failed with exit ${result.exitCode}`);
  }

  const files = [configPath, ...(await readdir(dataDir)).sort().map((name) => join(dataDir, name))];
  manifestCases.push({
    ...corpusCase,
    config: { path: basename(configPath), sha256: await sha256(configPath) },
    command,
    outputs: await Promise.all(
      files.slice(1).map(async (path) => ({
        path: `${corpusCase.name}/data/${basename(path)}`,
        bytes: Bun.file(path).size,
        sha256: await sha256(path),
      })),
    ),
  });
}

const manifest = {
  schema: 1,
  purpose: "tiny CPU-only Animal Cycle replay corpus",
  rulesVariant: "animal-cycle",
  setupModeIsMetadataOnly: true,
  replayFormat: { inputPlanes: 16, policyChannels: 8 },
  binary: { path: binary, bytes: Bun.file(binary).size, sha256: await sha256(binary) },
  cases: manifestCases,
};
await Bun.write(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${cases.length} games and manifest to ${output}`);
