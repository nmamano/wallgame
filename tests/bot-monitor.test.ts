/**
 * scripts/bot-monitor.sh alarms (board task 8a81a189): one alert per bot
 * forfeit and per engine crash, never one for history, never two for the same
 * event.
 *
 * The real script runs against a local stand-in for the site, a stand-in ssh
 * that runs the remote command in a temporary directory, and a stand-in for
 * the forced-command forfeit login that prints forfeits.txt. Its config file
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
      WALLGAME_FORFEITS_TARGET: "fake-sitehealth",
      WALLGAME_FORFEITS_SSH: join(dir, "fake-sitehealth"),
    },
  });
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return stdout;
};

const HEADER =
  "game_id|started_at|bot_id|bot_resign_cause|puzzle_id|moves_count";
const setForfeits = (rows: string[]): void => {
  writeFileSync(join(dir, "forfeits.txt"), [HEADER, ...rows, ""].join("\n"));
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
  writeFileSync(
    join(dir, "fake-sitehealth"),
    `#!/bin/bash\ncat "${dir}/forfeits.txt"\n`,
    { mode: 0o755 },
  );
  setForfeits([]);
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
  // The first run also sees an EMPTY forfeit list (set in beforeAll).
  it("learns the log end and the forfeits on its first run, and alerts nothing", async () => {
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

describe("bot monitor forfeit alarm", () => {
  it("alerts the first forfeit after a first run that saw none", async () => {
    setForfeits([
      "aaaa0001|2026-11-01T01:00:00Z|wsl-transformer-001:dw-transformer|bgs-unavailable-after-wait||12",
    ]);
    const first = alerts(await run());
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("Superhuman Bot forfeited a game");
    expect(first[0]).toContain("/game/aaaa0001");
    expect(first[0]).toContain("bgs-unavailable-after-wait");

    expect(alerts(await run())).toEqual([]);
  });

  it("names a puzzle and a bot it does not know", async () => {
    setForfeits([
      // A game id can start with "-"; grep must not read it as an option.
      "-MxYz003|2026-11-01T01:02:00Z|other-client:my-bot|bgs-missing-on-bot-turn||7",
      "aaaa0002|2026-11-01T01:01:00Z|wsl-transformer-001:dw-puzzle|bgs-unavailable-after-wait|lDqYVwprEa|11",
      "aaaa0001|2026-11-01T01:00:00Z|wsl-transformer-001:dw-transformer|bgs-unavailable-after-wait||12",
    ]);
    const found = alerts(await run());
    expect(found).toHaveLength(2);
    expect(found.join("\n")).toContain("PuzzleBot forfeited a game");
    expect(found.join("\n")).toContain("(puzzle lDqYVwprEa)");
    expect(found.join("\n")).toContain("other-client:my-bot forfeited a game");
    expect(alerts(await run())).toEqual([]);
  });

  it("alerts once when the list cannot be read, and once when it can again", async () => {
    rmSync(join(dir, "forfeits.txt"));
    const failed = alerts(await run());
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("Cannot read the bot forfeit list");
    expect(alerts(await run())).toEqual([]);

    // Any other answer than the list is a failure too, not an empty list.
    writeFileSync(join(dir, "forfeits.txt"), "site health: ok\n");
    expect(alerts(await run())).toEqual([]);

    setForfeits([
      "aaaa0004|2026-11-01T01:03:00Z|wsl-transformer-001:dw-easy|client-disconnect||30",
      "aaaa0001|2026-11-01T01:00:00Z|wsl-transformer-001:dw-transformer|bgs-unavailable-after-wait||12",
    ]);
    const back = alerts(await run());
    expect(back).toHaveLength(2);
    expect(back[0]).toContain("can be read again");
    expect(back[1]).toContain("Normal Bot forfeited a game");
  });
});
