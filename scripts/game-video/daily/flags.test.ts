import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { COMMAND_FLAGS, COMMAND_NAMES, GLOBAL_FLAGS } from "./crew.mjs";
import { flagFaults, parseFlagLine } from "./flags.mjs";

describe("crew.mjs flags (8a9ea73f)", () => {
  const spec = parseFlagLine("item edl* wait!");

  test("a flag line gives each name its kind", () => {
    expect([...spec]).toEqual([
      ["item", "value"],
      ["edl", "list"],
      ["wait", "switch"],
    ]);
    expect(() => parseFlagLine("item --edl")).toThrow("holds names");
  });

  test("good words have no fault", () => {
    expect(
      flagFaults(
        "x",
        ["--item", "v-1", "--edl", "a", "--edl", "b", "--wait"],
        spec,
      ),
    ).toEqual([]);
  });

  test("an unknown flag, a stray word, a missing value and a twice-given flag are faults", () => {
    expect(flagFaults("pick", ["--dry-run"], spec)).toEqual([
      "pick has no flag --dry-run; pick takes --item, --edl, --wait",
    ]);
    expect(flagFaults("x", ["v-1"], spec)[0]).toContain(
      '"v-1" is not a flag or a flag\'s value',
    );
    expect(flagFaults("x", ["--item"], spec)).toEqual(["--item needs a value"]);
    expect(flagFaults("x", ["--item", "--wait"], spec)).toEqual([
      "--item needs a value",
    ]);
    expect(flagFaults("x", ["--item", "a", "--item", "b"], spec)).toEqual([
      "--item is given twice",
    ]);
    expect(flagFaults("x", ["--wait", "now"], spec)[0]).toContain('"now"');
  });

  test("COMMAND_FLAGS names every command, and nothing else, and every line parses", () => {
    expect(Object.keys(COMMAND_FLAGS).sort()).toEqual(
      [...COMMAND_NAMES].sort(),
    );
    for (const line of [...Object.values(COMMAND_FLAGS), GLOBAL_FLAGS]) {
      expect(() => parseFlagLine(line)).not.toThrow();
    }
  });

  test("crew.mjs pick --dry-run stops before it reaches the app", () => {
    const run = Bun.spawnSync(
      [
        "node",
        resolve(import.meta.dir, "crew.mjs"),
        "pick",
        "--game",
        "abc",
        "--dry-run",
        // No app listens here: a pick that ran would fail on the fetch.
        "--app",
        "http://127.0.0.1:9",
      ],
      { env: { PATH: process.env.PATH! } },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toBe(
      "pick has no flag --dry-run; pick takes --report, --rank, --game, --style, --from, --caption, --title, --app, --docs\n",
    );
  });
});
