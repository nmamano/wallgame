/**
 * scripts/bot-monitor.sh crash alarm (board task 8a81a189): one alert per
 * engine crash, never one for history, never two for the same crash.
 *
 * The real script runs against a local stand-in for the site and a stand-in
 * ssh that runs the remote command in a temporary directory. Its config file
 * is an empty temporary file, so it can never read the real webhooks: every
 * alert goes to stdout as "[warn] no webhook; would send: ...".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "bot-monitor.sh");

const ALL_BOTS = [
  "dw-beginner",
  "dw-easy",
  "dw-transformer",
  "dw-puzzle",
  "experimental-animal-115",
].map((botId) => ({ botId }));

let server: ReturnType<typeof Bun.serve>;
let dir: string;

// Async on purpose: a blocking spawn would stop this process from serving the
// stand-in site the script is asking.
const run = async (): Promise<string> => {
  const child = Bun.spawn(["bash", SCRIPT], {
    stdout: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      WALLGAME_MONITOR_CONFIG: join(dir, "empty.env"),
      WALLGAME_MONITOR_STATE: join(dir, "state"),
      WALLGAME_API_BASE: `http://localhost:${server.port}`,
      WALLGAME_BOT_HOST: "fake-host",
      WALLGAME_BOT_LOG: "client.log",
      WALLGAME_MONITOR_SSH: join(dir, "fake-ssh"),
      WALLGAME_BOT_RESTART_CMD: "false",
    },
  });
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return stdout;
};

const alerts = (stdout: string): string[] =>
  stdout
    .split("[warn] no webhook; would send: ")
    .slice(1)
    .map((alert) => alert.trim());

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-monitor-test-"));
  writeFileSync(join(dir, "empty.env"), "");
  // The stand-in ssh: drop the host, run the command string here.
  writeFileSync(
    join(dir, "fake-ssh"),
    `#!/bin/bash\ncd "${dir}" && eval "\${@: -1}"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "client.log"), "");
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/bots") return Response.json(ALL_BOTS);
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("bot monitor crash alarm", () => {
  it("learns the log end on its first run, and alerts nothing", async () => {
    appendFileSync(
      join(dir, "client.log"),
      "[2026-10-27T09:24:15.334Z] [ERROR] Bot dw-puzzle will NOT be advertised: engine exited with code 139\n",
    );
    expect(alerts(await run())).toEqual([]);
  });

  it("alerts once per engine crash, with the engine's own words and no token", async () => {
    appendFileSync(
      join(dir, "client.log"),
      [
        "[2026-11-01T01:00:00.000Z] [INFO] bun run start --official-token s3cr3t-value",
        '[2026-11-01T01:00:01.000Z] [ERROR] Bot dw-transformer will NOT be advertised: engine exited with code 134 while running. Command: run "x"',
        "[2026-11-01T01:00:01.000Z] [ERROR]   dw-transformer said: F1101 terminate called after throwing --official-token s3cr3t-value",
        "[2026-11-01T01:00:02.000Z] [INFO] Evaluating position for session abc at ply 3",
        "",
      ].join("\n"),
    );
    const crash = alerts(await run());
    expect(crash).toHaveLength(1);
    expect(crash[0]).toContain("A bot engine crashed");
    expect(crash[0]).toContain(
      "Bot dw-transformer will NOT be advertised: engine exited with code 134",
    );
    expect(crash[0]).toContain("dw-transformer said: F1101 terminate called");
    expect(crash[0]).not.toContain("s3cr3t-value");
    expect(crash[0]).not.toContain("Evaluating position");

    expect(alerts(await run())).toEqual([]);
  });

  it("names every bot of a crash that took several engines down", async () => {
    appendFileSync(
      join(dir, "client.log"),
      [
        ...["dw-beginner", "dw-easy", "dw-transformer"].flatMap((bot) => [
          `[2026-11-01T03:00:00.000Z] [ERROR] Bot ${bot} will NOT be advertised: engine exited with code 139 within 2000ms of starting.`,
          ...[1, 2, 3, 4].map(
            (n) => `[2026-11-01T03:00:00.000Z] [ERROR]   ${bot} said: E${n}`,
          ),
        ]),
        "",
      ].join("\n"),
    );
    const crash = alerts(await run());
    expect(crash).toHaveLength(1);
    for (const bot of ["dw-beginner", "dw-easy", "dw-transformer"]) {
      expect(crash[0]).toContain(`Bot ${bot} will NOT be advertised`);
    }
  });

  it("starts the log from the beginning again after it was replaced", async () => {
    writeFileSync(
      join(dir, "client.log"),
      "[2026-11-01T02:00:00.000Z] [ERROR] Bot dw-easy will NOT be advertised: engine exited with code 1\n",
    );
    const crash = alerts(await run());
    expect(crash).toHaveLength(1);
    expect(crash[0]).toContain("Bot dw-easy will NOT be advertised");
  });
});
