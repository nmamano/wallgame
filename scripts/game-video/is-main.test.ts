import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { NODE_FLOOR } from "./is-main.mjs";

const IS_MAIN = resolve(import.meta.dir, "is-main.mjs");

/** Runs `isMain` on a given import.meta in a child, as a script named crew.mjs. */
const run = (meta: string) =>
  spawnSync(
    process.execPath,
    [
      "-e",
      `const { isMain } = await import(${JSON.stringify(IS_MAIN)});
       process.argv[1] = "/x/crew.mjs";
       console.log(String(isMain(${meta})));`,
    ],
    { encoding: "utf8" },
  );

test("an older Node, with no import.meta.main: the script stops with the reason", () => {
  const r = run("{}");
  expect(r.status).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain(
    `crew.mjs needs Node ${NODE_FLOOR} or later (for import.meta.main)`,
  );
});

test("a Node with import.meta.main: isMain returns it", () => {
  expect(run("{ main: true }").stdout.trim()).toBe("true");
  expect(run("{ main: false }").stdout.trim()).toBe("false");
});
