/**
 * A fake engine that starts and then dies, used by engine-failure.test.ts.
 *
 * This is the failure shape that actually happens in production: the binary
 * exists and is executable, so `Bun.spawn` returns a healthy-looking
 * Subprocess, and only milliseconds later does the process exit. The real
 * engine does exactly this when its model file is missing or TensorRT cannot
 * initialise (deep-wallwars/src/bgs_engine_main.cpp:246-277).
 *
 * It is deliberately NOT the same failure as a missing binary, which makes
 * `Bun.spawn` throw synchronously. The two take opposite paths through the
 * client, so the test needs both.
 *
 * The stderr line below is what the client must surface: before this task it
 * was captured and then dropped at the log threshold, so an engine died
 * without leaving a word behind.
 */

// Makes this file a module, for the same reason echo-engine.ts exports a type:
// it is spawned rather than imported, so nothing else gives it module status.
export const FIXTURE = "dying-engine";

process.stderr.write(
  "bgs_engine_main: Error: Failed to open model file: /nonexistent/model.trt\n",
);
process.exit(3);
