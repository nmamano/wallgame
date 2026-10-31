import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "nightly-candidates.sh");
const STAMP = "20261031T102000Z";

/** Runs the script with arguments it must refuse before it reads anything. */
const refuse = (args: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-usage-"));
  const out = join(dir, "out");
  try {
    const proc = Bun.spawnSync({ cmd: ["bash", SCRIPT, out, ...args] });
    return { code: proc.exitCode, created: existsSync(out) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("nightly-candidates.sh options", () => {
  test("--days and --nil-seat are refused without --manual-stamp", () => {
    expect(refuse(["--nil-seat"])).toEqual({ code: 64, created: false });
    expect(refuse(["--days", "30"])).toEqual({ code: 64, created: false });
    expect(refuse(["--members"])).toEqual({ code: 64, created: false });
  });

  test("a bad --days, a bad stamp or an unknown option is refused", () => {
    for (const args of [
      ["--manual-stamp", STAMP, "--days", "0"],
      ["--manual-stamp", STAMP, "--days", "x"],
      ["--manual-stamp", STAMP, "--days"],
      ["--manual-stamp", "today"],
      ["--manual-stamp", STAMP, "--top", "5"],
    ]) {
      expect(refuse(args)).toEqual({ code: 64, created: false });
    }
  });

  test("no OUT_DIR is refused", () => {
    const proc = Bun.spawnSync({ cmd: ["bash", SCRIPT] });
    expect(proc.exitCode).toBe(64);
  });
});
