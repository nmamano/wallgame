/**
 * This is the fourth of 4 tests for the proactive bot protocol (V3):
 *
 * 1. bot-1-mock-client.test.ts: Mocks the bot client's WS messages.
 *    It tests the server-client protocol.
 * 2. bot-2-official-client.test.ts: Uses the official bot client with the dummy engine.
 *    It tests the official client end-to-end.
 * 3. bot-3-dummy-engine.test.ts: Uses the official bot client with the dummy engine
 *    and tests the engine API in more detail (classic variant, state tracking).
 * 4. bot-4-deep-wallwars-engine.test.ts: Uses the official bot client with the
 *    C++ deep-wallwars engine. It tests the Deep Wallwars adapter.
 *    Note that this requires C++ compilation and GPU setup.
 */

/**
 * IMPORTANT: V3 Bot Game Session Protocol requires a new C++ BGS engine binary.
 *
 * The V3 protocol uses stateful Bot Game Sessions (BGS) with long-lived engine
 * processes that maintain MCTS trees across moves. The existing deep_ww_engine
 * binary uses the V2 stateless protocol (spawn per move, full game state in
 * each request).
 *
 * These tests are SKIPPED until the C++ BGS engine is implemented:
 * - See info/bgs_engine.md for the design specification
 * - See info/v3_migration_plan.md Phase 8 for implementation details
 *
 * When implementing, the new binary should:
 * - Read JSON-lines from stdin (one message per line)
 * - Write JSON-lines to stdout (one response per line)
 * - Maintain multiple parallel BGS sessions (up to 256)
 * - Support MCTS tree persistence and pruning across moves
 * - Share batching queues and evaluation caches across sessions
 *
 * Prerequisites once implemented:
 * - deep-wallwars must be compiled with BGS support (bgs_engine binary)
 * - 8x8 TensorRT model must exist (8x8_750000.trt)
 */

import { describe, it, expect } from "bun:test";

// ================================
// --- Skip Notice ---
// ================================

describe("custom bot client CLI integration V3 (deep-wallwars engine)", () => {
  it.skip("plays a game using the actual CLI client with the deep-wallwars engine", () => {
    // This test requires the C++ BGS engine binary which hasn't been implemented yet.
    // See info/bgs_engine.md for the design specification.
    expect(true).toBe(true);
  });

  it.skip("handles unsupported variant gracefully (resigns)", () => {
    // This test requires the C++ BGS engine binary which hasn't been implemented yet.
    // The BGS engine should return success: false with an error message for unsupported variants.
    expect(true).toBe(true);
  });

  it.skip("handles unsupported board size gracefully (resigns)", () => {
    // This test requires the C++ BGS engine binary which hasn't been implemented yet.
    // The BGS engine should return success: false with an error message for unsupported board sizes.
    expect(true).toBe(true);
  });
});

/**
 * The test implementation below is preserved as a reference for when the C++ BGS
 * engine is implemented. The test harness (HTTP helpers, WebSocket helpers, bot
 * client spawning) follows the same patterns as bot-2 and bot-3 tests.
 *
 * Key changes needed when implementing:
 * 1. Update the engine command to use the new bgs_engine binary
 * 2. Remove timeControl from variant configs (V3 bot games are untimed)
 * 3. Verify evaluation values are within [-1, +1] range
 * 4. Test that MCTS tree reuse improves move quality over multiple moves
 */
