/**
 * Unit tests for EngineProcess request/response correlation.
 *
 * Regression coverage for the request-collision-on-game-end bug: pendingRequests
 * used to be keyed by bgsId alone, so only one engine request per session could
 * be in flight. Because the server sends end_game_session without waiting for an
 * outstanding (slow) evaluate_position, the second send() threw and the session
 * ended up mis-handled. pendingRequests is now keyed by (requestType, bgsId), so
 * different-type requests for the same session coexist while a genuine same-type
 * duplicate is still rejected.
 *
 * These tests spawn a tiny fake engine (see __fixtures__/echo-engine.ts) over the
 * real JSON-lines transport — no server, DB, or GPU needed.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { EngineProcess } from "./engine-runner";
import type { EngineRequestV3 } from "../../shared/custom-bot/engine-api";

const ENGINE_CMD = `bun run ${join(import.meta.dir, "__fixtures__/echo-engine.ts")}`;

let engine: EngineProcess | undefined;

afterEach(() => {
  engine?.kill();
  engine = undefined;
});

describe("EngineProcess pendingRequests keying", () => {
  it("routes concurrent different-type requests for the same session to the right responses", async () => {
    engine = await EngineProcess.spawn(ENGINE_CMD, "test-bot");
    const bgsId = "session-collision";

    // A slow evaluate_position is in flight when an end_game_session arrives for
    // the same session — the exact collision window from the bug report.
    const evalReq: EngineRequestV3 = {
      type: "evaluate_position",
      bgsId,
      expectedPly: 4,
    };
    const endReq: EngineRequestV3 = { type: "end_game_session", bgsId };

    const evalPromise = engine.send(evalReq);
    const endPromise = engine.send(endReq);

    const [evalRes, endRes] = await Promise.all([evalPromise, endPromise]);

    // Each response is routed back to its own request, not swapped.
    expect(evalRes.type).toBe("evaluate_response");
    expect(evalRes.bgsId).toBe(bgsId);
    expect(endRes.type).toBe("game_session_ended");
    expect(endRes.bgsId).toBe(bgsId);
  });

  it("still rejects a genuine same-type duplicate for the same session", async () => {
    engine = await EngineProcess.spawn(ENGINE_CMD, "test-bot");
    const bgsId = "session-dup";

    const first = engine.send({
      type: "evaluate_position",
      bgsId,
      expectedPly: 1,
    });

    // Second evaluate for the same session while the first is still pending:
    // its response would be indistinguishable from the first, so it must throw.
    expect(() =>
      engine!.send({ type: "evaluate_position", bgsId, expectedPly: 1 }),
    ).toThrow(/pending evaluate_position request/i);

    const firstRes = await first;
    expect(firstRes.type).toBe("evaluate_response");

    // After the first resolves, the same-type request is allowed again.
    const third = await engine.send({
      type: "evaluate_position",
      bgsId,
      expectedPly: 2,
    });
    expect(third.type).toBe("evaluate_response");
  });

  it("keeps separate sessions independent", async () => {
    engine = await EngineProcess.spawn(ENGINE_CMD, "test-bot");

    const a = engine.send({
      type: "evaluate_position",
      bgsId: "A",
      expectedPly: 0,
    });
    const b = engine.send({
      type: "evaluate_position",
      bgsId: "B",
      expectedPly: 0,
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.bgsId).toBe("A");
    expect(rb.bgsId).toBe("B");
  });

  it("can close stdin and wait for a clean engine shutdown", async () => {
    engine = await EngineProcess.spawn(ENGINE_CMD, "test-bot");
    await expect(engine.shutdown()).resolves.toBe(0);
    expect(engine.alive).toBe(false);
    engine = undefined;
  });
});
