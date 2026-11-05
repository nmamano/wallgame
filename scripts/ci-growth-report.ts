/**
 * The numbers that grow with every merge, printed by CI. REPORT ONLY: it
 * never fails the build (board task 2aacada6, engineering health 2026-11-03).
 * Each number has a limit, and the report warns at 80% of it:
 *
 * - lint peak RSS against the heap cap that `lint:check` sets. At 2026-11-03
 *   it was 3.17 GiB of 4 GiB (79%); one more typed project can crash lint
 *   with exit 134. Raise the cap with any new typed project. The cap went
 *   to 6 GiB on 2026-11-05: with that room, peak RSS was 3.94-4.01 GiB, up
 *   from 3.24-3.44 GiB under 4 GiB, because V8 collects harder near its cap.
 * - first-load JS (what index.html loads before the app starts), raw and
 *   gzip, against Vite's chunk-size warning.
 * - tracked source files against 3,000 lines.
 *
 * Crew doc sizes are not here: those docs live in a local repo that CI never
 * sees, and the improve loop checks them.
 *
 *   bun scripts/ci-growth-report.ts lint     runs `bun run lint:check`, records
 *                                            its peak RSS, exits with its code
 *   bun scripts/ci-growth-report.ts report   prints the report, always exits 0
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LINT_RSS_FILE = join(ROOT, "tmp/ci-growth/lint-peak-rss-bytes");
const DIST = join(ROOT, "frontend/dist");
const VITE_CONFIG = join(ROOT, "frontend/vite.config.ts");
const WARN_RATIO = 0.8;
const MAX_FILE_LINES = 3000;
// Vite's own default, used when vite.config.ts sets no chunkSizeWarningLimit.
const VITE_DEFAULT_CHUNK_WARNING_KB = 500;
const SOURCE_PATTERNS = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.js",
  "*.mjs",
  "*.cjs",
  "*.css",
  "*.html",
  "*.py",
  "*.cpp",
  "*.hpp",
  "*.h",
  "*.cu",
  "*.sh",
];
// Written by a tool, not by hand, so its length is not a design signal.
const GENERATED = new Set(["frontend/src/routeTree.gen.ts"]);

const MiB = 1024 * 1024;

const warn = (message: string) => {
  console.log(
    process.env.GITHUB_ACTIONS
      ? `::warning::${message}`
      : `WARNING: ${message}`,
  );
};

const percent = (value: number, limit: number) =>
  `${Math.round((100 * value) / limit)}%`;

/** Prints one measured line, as a warning when it is at 80% or more. */
const check = (label: string, value: number, limit: number, show: string) => {
  const line = `${label}: ${show} (${percent(value, limit)} of the limit)`;
  if (value >= WARN_RATIO * limit) warn(line);
  else console.log(line);
};

const runLint = async (): Promise<number> => {
  const lint = Bun.spawn(["bun", "run", "lint:check"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await lint.exited;
  // maxRSS is in bytes and covers the eslint process that `bun run` starts.
  const peak = lint.resourceUsage()?.maxRSS;
  if (peak !== undefined) {
    mkdirSync(dirname(LINT_RSS_FILE), { recursive: true });
    writeFileSync(LINT_RSS_FILE, String(peak));
  }
  return exitCode;
};

const reportLint = () => {
  const script = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts["lint:check"];
  const capMiB = Number(/--max-old-space-size=(\d+)/.exec(script)?.[1]);
  if (!capMiB) {
    warn("lint:check sets no --max-old-space-size, so lint has no heap cap");
    return;
  }
  if (!existsSync(LINT_RSS_FILE)) {
    console.log(
      "lint peak RSS: not measured (run `bun scripts/ci-growth-report.ts lint` first)",
    );
    return;
  }
  const peak = Number(readFileSync(LINT_RSS_FILE, "utf8"));
  // RSS also holds memory outside the V8 heap, so this overstates the heap a
  // little; it is the number the 2026-11-03 baseline used.
  check(
    "lint peak RSS vs heap cap",
    peak,
    capMiB * MiB,
    `${(peak / MiB / 1024).toFixed(2)} GiB of ${(capMiB / 1024).toFixed(2)} GiB`,
  );
};

const reportFirstLoad = () => {
  const indexHtml = join(DIST, "index.html");
  if (!existsSync(indexHtml)) {
    console.log("first-load JS: not measured (no frontend/dist; build first)");
    return;
  }
  const html = readFileSync(indexHtml, "utf8");
  const scripts = [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g),
    ...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="([^"]+\.js)"/g),
  ].map((match) => match[1]);
  const configured = /chunkSizeWarningLimit:\s*(\d+)/.exec(
    readFileSync(VITE_CONFIG, "utf8"),
  )?.[1];
  const limitKb = configured
    ? Number(configured)
    : VITE_DEFAULT_CHUNK_WARNING_KB;

  let rawTotal = 0;
  let gzipTotal = 0;
  for (const src of [...new Set(scripts)]) {
    const code = readFileSync(join(DIST, src));
    const gzip = Bun.gzipSync(code).length;
    rawTotal += code.length;
    gzipTotal += gzip;
    // Vite counts kB as 1000 bytes of raw code per chunk.
    check(
      `first-load chunk ${src}`,
      code.length / 1000,
      limitKb,
      `${(code.length / 1000).toFixed(0)} kB raw, ${(gzip / 1000).toFixed(0)} kB gzip; limit ${limitKb} kB raw (Vite chunk warning)`,
    );
  }
  console.log(
    `first-load JS total: ${scripts.length} file(s), ${(rawTotal / 1000).toFixed(0)} kB raw, ${(gzipTotal / 1000).toFixed(0)} kB gzip`,
  );
};

const reportLongFiles = () => {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--", ...SOURCE_PATTERNS],
    {
      cwd: ROOT,
    },
  );
  const files = listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file && !GENERATED.has(file));
  const long = files
    .map((file) => {
      const text = readFileSync(join(ROOT, file), "utf8");
      return {
        file,
        lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
      };
    })
    .filter(({ lines }) => lines >= WARN_RATIO * MAX_FILE_LINES)
    .sort((a, b) => b.lines - a.lines);
  const over = long.filter(({ lines }) => lines > MAX_FILE_LINES).length;
  console.log(
    `source files over ${MAX_FILE_LINES} lines: ${over} of ${files.length} tracked source files`,
  );
  for (const { file, lines } of long) {
    check(`file ${file}`, lines, MAX_FILE_LINES, `${lines} lines`);
  }
};

const mode = process.argv[2];
if (mode === "lint") {
  process.exit(await runLint());
} else if (mode === "report") {
  for (const section of [reportLint, reportFirstLoad, reportLongFiles]) {
    try {
      section();
    } catch (error) {
      // Report only: a broken measurement is printed, never a failed build.
      warn(`${section.name} could not measure: ${String(error)}`);
    }
  }
} else {
  console.error("usage: bun scripts/ci-growth-report.ts lint|report");
  process.exit(2);
}
