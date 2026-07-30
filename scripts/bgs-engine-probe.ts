/**
 * Process-level probe for the BGS engine's concurrency behaviour.
 *
 * This is a DIAGNOSTIC, not a normal gate: it needs the CUDA engine, which only
 * builds on the 4090 desktop, so it cannot run in CI. It exists because the
 * Catch2 regression test in deep-wallwars/test/request_dispatcher.cpp can only
 * exercise the dispatcher class - it cannot show that the SHIPPED BINARY used to
 * wedge. This can, by running the identical message corpus against the old and
 * new binaries.
 *
 * WHAT IT FOUND (2026-07-30, at 1caaa61, before the fix):
 *
 *   --thread_pool_size 4    2 concurrent evaluates ->  2/2 in 239 ms
 *   --thread_pool_size 4    3 concurrent evaluates ->  3/3 in 258 ms
 *   --thread_pool_size 4    4 concurrent evaluates ->  0/4  WEDGED
 *   --thread_pool_size 8    4 concurrent evaluates ->  4/4 in 251 ms
 *   --thread_pool_size 8    8 concurrent evaluates ->  0/8  WEDGED
 *   --thread_pool_size 2    2 concurrent evaluates ->  0/2  WEDGED
 *   --thread_pool_size 12  12 concurrent evaluates -> 0/12  WEDGED
 *
 * The cliff sat at exactly the pool size for every pool size tested, which is
 * what made it the mechanism rather than a coincidence at 4. Production runs
 * --thread_pool_size 4. Also, 144 sessions created one at a time all succeeded
 * and then 144 concurrent evaluates returned 0 answers in 90 s.
 *
 * SAFETY RULES BAKED IN HERE, all of them learned the hard way:
 *
 * - Spawns its OWN throwaway engine every time. Bulk-pumping a SERVING engine is
 *   what segfaulted production on 2026-07-26; nothing here may ever be pointed
 *   at the engines the bot client owns.
 * - IDENTITY BEFORE SIGNAL. Every launch gets a unique `--seed`, and no signal is
 *   ever sent until /proc/<pid>/cmdline has been read and shown to contain both
 *   the engine path and that exact seed. Existence of a pid is not identity:
 *   Linux reuses pids, and the serving Superhuman bot runs the same binary, so a
 *   bare `kill <captured pid>` could hit production. A mismatch REFUSES to
 *   signal and reports it.
 * - Fails closed. If no pid arrives within the deadline, the run aborts before
 *   sending any protocol traffic rather than proceeding with an engine it cannot
 *   identify or reclaim.
 * - Natural exit is given a chance FIRST, and whether shutdown was natural or
 *   forced is part of the verdict. A wedged engine cannot exit on its own (stdin
 *   EOF cannot unwind a pool whose threads are all blocked), so "forced" is the
 *   BEFORE signature and "natural" is required of the fixed binary.
 * - Every wait is bounded, and a timeout is reported as a failure, never a pass.
 * - A response's mere existence is never the verdict. Evaluations must succeed
 *   with a non-empty move, and ids must belong to the requested set.
 *
 * Usage:
 *   bun scripts/bgs-engine-probe.ts --scenario ladder
 *   bun scripts/bgs-engine-probe.ts --scenario corpus --sessions 144 --threads 4
 *   bun scripts/bgs-engine-probe.ts --scenario race --rounds 40
 *   bun scripts/bgs-engine-probe.ts --scenario band --values 1,2,4,8,112
 *
 * Exit code is 0 only if the scenario met every condition above.
 */
import { spawn } from "bun";
import { buildStandardInitialState } from "../shared/domain/standard-setup";

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
};
const numFlag = (name: string, fallback: number) =>
  Number(flag(name, String(fallback)));

const SSH_TARGET = flag("ssh", "nilo@desktop-053vvpl-1");
const SCENARIO = flag("scenario", "corpus");
const SAMPLES = numFlag("samples", 200);
const PARALLEL = numFlag("parallel", 32);
const THREADS = numFlag("threads", 4);
const SESSIONS = numFlag("sessions", 144);
const ROUNDS = numFlag("rounds", 40);
const WIDTH = numFlag("width", 8);
const HEIGHT = numFlag("height", 8);
const VARIANT = flag("variant", "standard");
const TIMEOUT_MS = numFlag("timeout", 90_000);
const MODEL = flag("model", "tf_curriculum_model_73.trt");

/** How long a healthy engine gets to exit by itself after stdin closes. */
const SHUTDOWN_GRACE_MS = numFlag("grace", 15_000);
/** How long to wait for the pid marker before giving up and aborting. */
const PID_DEADLINE_MS = 20_000;
/** Bound on draining the stderr pump and reaping the local ssh client. */
const REAP_BUDGET_MS = 5_000;

const ENGINE_BINARY = "deep_ww_bgs_engine";

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

type Msg = { type: string; bgsId: string } & Record<string, unknown>;
type Resp = Record<string, unknown>;

/** Why the throwaway engine is gone, if it is. */
type CleanupVerdict =
  | "not-needed" // exited naturally, nothing to kill
  | "killed" // identity verified, then terminated
  | "gone-already" // vanished between the grace wait and the check
  | "refused-mismatch" // cmdline did not match: NOT signalled
  | "leaked" // survived TERM and KILL
  | "no-pid"; // never identified

type Shutdown = {
  /** ssh exited AND the remote pid is gone. Both, not either. */
  natural: boolean;
  sshExitCode: number | null;
  cleanup: CleanupVerdict;
  stderr: string[];
  /** False if the exit code or the final stderr could not be collected. */
  reapComplete: boolean;
};

const startConfig = () => ({
  variant: VARIANT,
  boardWidth: WIDTH,
  boardHeight: HEIGHT,
  initialState: buildStandardInitialState(WIDTH, HEIGHT),
});

/**
 * `--seed` is a gflags **uint32**, so the marker has to fit in one.
 *
 * The first version of this computed `(Date.now() % 1e8) * 100 + counter`, which
 * is around 7.9e9 - above UINT32_MAX - so the engine would have rejected the flag
 * outright before startup for most of any given day. JavaScript's number range is
 * wider than the flag's; that difference has to be handled here, not assumed
 * away. A random uint32 is unique enough for process identity and cannot overflow
 * by construction.
 */
const UINT32_MAX = 4_294_967_295;

const nextSeed = (): number => {
  for (;;) {
    const candidate = crypto.getRandomValues(new Uint32Array(1))[0];
    // 42 is the engine's own default and 0 is a suspicious sentinel; neither
    // makes a good identity marker.
    if (candidate !== 0 && candidate !== 42) return candidate;
  }
};

/** Throws unless `seed` is something gflags will actually accept as a uint32. */
const assertUint32Seed = (seed: number) => {
  if (!Number.isInteger(seed) || seed < 0 || seed > UINT32_MAX) {
    throw new Error(
      `generated seed ${seed} is not a uint32 - the engine would reject --seed ` +
        `and the probe would have no identity marker`,
    );
  }
};

/**
 * A throwaway engine on the desktop.
 *
 * Throws if it cannot be identified, so no caller can end up driving an engine
 * it would be unable to reclaim.
 */
const openEngine = async (samples: number, threads: number) => {
  const seed = nextSeed();
  assertUint32Seed(seed);
  // --seed is deliberately NOT last, so a cmdline match can require a trailing
  // space and never confuse seed 12345 with seed 123456.
  const remote =
    `cd ~/nil/wallgame/official-custom-bot-client && ` +
    `echo "PROBE_PID $$" >&2 && exec nice -n15 ` +
    `../deep-wallwars/build-tests/${ENGINE_BINARY} ` +
    `--model ../deep-wallwars/models_serving/${MODEL} ` +
    `--seed ${seed} ` +
    `--samples ${samples} --parallel_samples ${PARALLEL} ` +
    `--thread_pool_size ${threads}`;

  const proc = spawn(["ssh", "-o", "ConnectTimeout=15", SSH_TARGET, remote], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let remotePid: number | undefined;
  const stderrLines: string[] = [];
  // Consumed continuously: a full stderr pipe would block the engine. The
  // promise lets shutdown await the final lines instead of racing them.
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stderr) {
      pending += decoder.decode(chunk);
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const pidMatch = /^PROBE_PID (\d+)$/.exec(line.trim());
        if (pidMatch) remotePid = Number(pidMatch[1]);
        else if (line.trim() !== "") stderrLines.push(line);
      }
    }
    if (pending.trim() !== "") stderrLines.push(pending);
  })();

  const reader = proc.stdout.getReader();
  let buffer = "";

  const readLine = async (
    deadline: number,
  ): Promise<Resp | "timeout" | "eof"> => {
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        return JSON.parse(line) as Resp;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk === "timeout") return "timeout";
      if (chunk.done) return "eof";
      buffer += new TextDecoder().decode(chunk.value);
    }
  };

  const write = async (msg: Msg) => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    await proc.stdin.flush();
  };

  /** Send one message and require the matching response, by type AND bgsId. */
  const sendAndAwait = async (msg: Msg, expected: string): Promise<Resp> => {
    await write(msg);
    const response = await readLine(Date.now() + TIMEOUT_MS);
    if (response === "timeout") {
      throw new Error(`TIMEOUT awaiting ${expected} for ${msg.bgsId}`);
    }
    if (response === "eof") {
      throw new Error(`ENGINE EXITED awaiting ${expected} for ${msg.bgsId}`);
    }
    if (response.type !== expected || response.bgsId !== msg.bgsId) {
      throw new Error(
        `unexpected response to ${msg.type} (${msg.bgsId}): ` +
          JSON.stringify(response).slice(0, 240),
      );
    }
    return response;
  };

  /**
   * Verify identity, THEN signal. The check and the kill happen in one remote
   * shell so the window between them is as small as it can be, and a cmdline
   * that does not carry both the engine path and our unique seed is refused
   * outright rather than signalled hopefully.
   */
  const verifiedKill = async (): Promise<CleanupVerdict> => {
    const script =
      `P=${remotePid}; S="--seed ${seed} "; ` +
      `if [ ! -d /proc/$P ]; then echo GONE_ALREADY; exit 0; fi; ` +
      `C=$(tr "\\0" " " < /proc/$P/cmdline 2>/dev/null); ` +
      `case "$C" in *${ENGINE_BINARY}*"$S"*) ;; ` +
      `*) echo "MISMATCH $C"; exit 0;; esac; ` +
      `kill -TERM $P 2>/dev/null; sleep 2; ` +
      `if [ -d /proc/$P ]; then kill -KILL $P 2>/dev/null; sleep 1; fi; ` +
      `if [ -d /proc/$P ]; then echo LEAKED; else echo KILLED; fi`;
    const check = spawn(
      ["ssh", "-o", "ConnectTimeout=15", SSH_TARGET, script],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const out = (await new Response(check.stdout).text()).trim();
    if (out.startsWith("MISMATCH")) {
      log(
        `  REFUSED to signal pid ${remotePid}: cmdline does not match our launch`,
      );
      log(`    saw: ${out.slice(9, 220)}`);
      return "refused-mismatch";
    }
    if (out === "GONE_ALREADY") return "gone-already";
    if (out === "KILLED") return "killed";
    if (out === "LEAKED") {
      log(
        `  WARNING: throwaway engine pid ${remotePid} survived TERM and KILL`,
      );
      return "leaked";
    }
    log(
      `  WARNING: unrecognised cleanup output for pid ${remotePid}: ${out.slice(0, 120)}`,
    );
    return "leaked";
  };

  const waitForLocalExit = async (budgetMs: number) => {
    const deadline = Date.now() + budgetMs;
    while (proc.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(100);
    }
  };

  /**
   * READ-ONLY liveness check on the remote pid. Sends no signal, so it is safe to
   * run before we have decided anything.
   *
   * "unknown" on any ambiguity, and callers must treat that as possibly-alive:
   * assuming a dead engine is how one leaks.
   */
  const remoteAlive = async (): Promise<boolean | "unknown"> => {
    const script = `if [ -d /proc/${remotePid} ]; then echo ALIVE; else echo GONE; fi`;
    const check = spawn(
      ["ssh", "-o", "ConnectTimeout=15", SSH_TARGET, script],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(check.stdout).text()).trim();
    if (out === "ALIVE") return true;
    if (out === "GONE") return false;
    return "unknown";
  };

  /**
   * Close stdin, give the engine a real chance to finish and exit on its own,
   * and only force it if it will not.
   *
   * "Natural" requires BOTH that the local ssh client exited AND that the remote
   * pid is gone. The ssh client exiting on its own is not enough: a dropped
   * connection would exit ssh while the engine kept running, which would both
   * misgrade the D4 evidence and leak a throwaway engine next to the live bots.
   */
  const shutdown = async (): Promise<Shutdown> => {
    try {
      proc.stdin.end();
    } catch {}

    await waitForLocalExit(SHUTDOWN_GRACE_MS);
    const sshExited = proc.exitCode !== null;

    let natural = false;
    let cleanup: CleanupVerdict;

    if (remotePid === undefined) {
      cleanup = "no-pid";
    } else {
      // Only worth asking if ssh is gone; while ssh is alive so is the engine.
      const alive = sshExited ? await remoteAlive() : true;
      if (sshExited && alive === false) {
        natural = true;
        cleanup = "not-needed";
      } else {
        if (sshExited && alive === "unknown") {
          log(
            `  remote liveness for pid ${remotePid} is UNKNOWN - treating as alive and verifying`,
          );
        }
        cleanup = await verifiedKill();
        await waitForLocalExit(REAP_BUDGET_MS);
        try {
          if (proc.exitCode === null) proc.kill();
        } catch {}
        // Second bounded wait: the first one ran BEFORE the local kill, so
        // without this the ssh exit code could still be reported as null.
        await waitForLocalExit(REAP_BUDGET_MS);
      }
    }

    // Bounded, so a stuck pipe cannot hang the probe itself. Awaited after any
    // forced cleanup too, so the final stderr lines are not lost.
    const stderrDrained = await Promise.race([
      stderrDone.then(() => true),
      Bun.sleep(REAP_BUDGET_MS).then(() => false),
    ]);

    const reapComplete = stderrDrained && proc.exitCode !== null;
    if (!reapComplete) {
      log(
        `  INCOMPLETE REAP: stderrDrained=${stderrDrained} ` +
          `sshExitCode=${String(proc.exitCode)} - shutdown evidence is partial`,
      );
    }

    return {
      natural,
      sshExitCode: proc.exitCode,
      cleanup,
      stderr: stderrLines,
      reapComplete,
    };
  };

  // FAIL CLOSED. Abort before any protocol traffic if we could not identify the
  // engine, because we would not be able to reclaim it either.
  const pidDeadline = Date.now() + PID_DEADLINE_MS;
  while (remotePid === undefined && Date.now() < pidDeadline) {
    await Bun.sleep(100);
  }
  if (remotePid === undefined) {
    try {
      proc.stdin.end();
      proc.kill();
    } catch {}
    await Promise.race([stderrDone, Bun.sleep(REAP_BUDGET_MS)]);
    throw new Error(
      `no PROBE_PID within ${PID_DEADLINE_MS}ms - refusing to drive an engine ` +
        `we cannot identify. stderr: ${stderrLines.slice(-5).join(" | ").slice(0, 400)}`,
    );
  }

  return {
    readLine,
    write,
    sendAndAwait,
    shutdown,
    seed,
    remotePid,
  };
};

/** Print the shutdown evidence in one place, so every scenario reports it. */
const reportShutdown = (label: string, shutdown: Shutdown) => {
  log(
    `  ${label}: exit=${shutdown.natural ? "NATURAL" : "FORCED"} ` +
      `sshExitCode=${String(shutdown.sshExitCode)} cleanup=${shutdown.cleanup} ` +
      `reapComplete=${shutdown.reapComplete} stderrLines=${shutdown.stderr.length}`,
  );
  for (const line of shutdown.stderr.slice(-5)) log(`    ${line}`);
};

/**
 * Create `sessions` sessions one at a time (the CONTROL - it proves this very
 * process is healthy on the serialized path), then fire one evaluate per session
 * with no waiting.
 *
 * Passes only if every requested id came back exactly once, with success and a
 * non-empty move, nothing unexpected arrived, and the engine then exited by
 * itself. Counting response objects would happily certify an engine that answers
 * "No legal move available" 144 times.
 */
const runCorpus = async (sessions: number, threads: number) => {
  log(
    `CORPUS: ${sessions} sessions, samples=${SAMPLES} parallel=${PARALLEL} ` +
      `threads=${threads}, timeout=${TIMEOUT_MS}ms`,
  );
  const engine = await openEngine(SAMPLES, threads);
  log(`  throwaway engine pid ${engine.remotePid} seed ${engine.seed}`);

  const expected = new Set<string>();
  for (let i = 0; i < sessions; i++) expected.add(`corpus-${i}`);

  const seen = new Map<string, number>();
  let unexpected = 0;
  let failedEvaluations = 0;
  let controlOk = false;

  try {
    for (let i = 0; i < sessions; i++) {
      const started = await engine.sendAndAwait(
        {
          type: "start_game_session",
          bgsId: `corpus-${i}`,
          botId: "probe",
          config: startConfig(),
        },
        "game_session_started",
      );
      if (started.success !== true) {
        throw new Error(
          `session corpus-${i} did not start: ${JSON.stringify(started).slice(0, 200)}`,
        );
      }
    }
    controlOk = true;
    log(
      `  CONTROL ok: ${sessions}/${sessions} sessions created and confirmed one at a time`,
    );

    const startedAt = Date.now();
    for (let i = 0; i < sessions; i++) {
      await engine.write({
        type: "evaluate_position",
        bgsId: `corpus-${i}`,
        expectedPly: 0,
      });
    }
    log(`  fired ${sessions} evaluate_position messages with no waiting`);

    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const response = await engine.readLine(deadline);
      if (response === "timeout") break;
      if (response === "eof") {
        log(`  ENGINE EXITED after ${seen.size} responses  <-- CRASH?`);
        break;
      }
      if (response.type !== "evaluate_response") {
        unexpected++;
        log(`  UNEXPECTED ${JSON.stringify(response).slice(0, 200)}`);
        continue;
      }
      const bgsId = String(response.bgsId);
      if (!expected.has(bgsId)) {
        unexpected++;
        log(`  UNEXPECTED bgsId ${bgsId}`);
        continue;
      }
      seen.set(bgsId, (seen.get(bgsId) ?? 0) + 1);
      const move =
        typeof response.bestMove === "string" ? response.bestMove : "";
      if (response.success !== true || move === "") failedEvaluations++;
      if (seen.size >= sessions) break;
    }

    const duplicates = [...seen.values()].filter((n) => n > 1).length;
    log(
      `  RESULT: ${seen.size}/${sessions} distinct expected ids in ${Date.now() - startedAt}ms, ` +
        `duplicates=${duplicates} unexpected=${unexpected} failedEvaluations=${failedEvaluations}`,
    );
    const responsesOk =
      seen.size === sessions &&
      duplicates === 0 &&
      unexpected === 0 &&
      failedEvaluations === 0;
    if (!responsesOk) {
      log(
        `    <-- ${seen.size === 0 ? "WEDGED" : "INCOMPLETE OR DEGRADED"}: not a pass`,
      );
    }

    const shutdown = await engine.shutdown();
    reportShutdown("shutdown", shutdown);
    // A fixed engine must be able to exit on its own; a wedged one cannot,
    // because stdin EOF cannot unwind a pool whose threads are all blocked.
    const ok =
      controlOk && responsesOk && shutdown.natural && shutdown.reapComplete;
    log(`  VERDICT: ${ok ? "PASS" : "FAIL"}`);
    return ok;
  } catch (error) {
    log(`  THREW ${String(error)}`);
    reportShutdown("shutdown", await engine.shutdown());
    log(`  VERDICT: FAIL`);
    return false;
  }
};

/** Walk the concurrency ladder, one engine process per rung. */
const runLadder = async () => {
  const rungs = flag("rungs", "4:2,4:3,4:4,8:4,8:8,2:2,12:12")
    .split(",")
    .map((rung) => {
      const [threads, sessions] = rung.split(":").map(Number);
      return { threads, sessions };
    });
  log(`LADDER over ${rungs.length} rungs (threads:concurrent)`);
  const results: string[] = [];
  for (const rung of rungs) {
    const ok = await runCorpus(rung.sessions, rung.threads);
    results.push(
      `threads=${rung.threads} concurrent=${rung.sessions}: ${ok ? "PASS" : "FAIL"}`,
    );
  }
  log(`LADDER SUMMARY:`);
  for (const line of results) log(`  ${line}`);
  return results.every((line) => line.endsWith("PASS"));
};

/**
 * end_game_session racing evaluate_position, on fresh session ids each round.
 * Fresh ids matter because root Dirichlet noise is seeded from the bgsId, so
 * reusing one id would repeat a single interleaving rather than explore them.
 *
 * Each round must produce exactly one evaluate_response AND one
 * game_session_ended for THAT round's id, each coherent. Two arbitrary JSON
 * lines are not evidence.
 */
const runRace = async (rounds: number) => {
  log(
    `RACE: ${rounds} rounds of evaluate-vs-end on fresh session ids, threads=${THREADS}`,
  );
  const engine = await openEngine(SAMPLES, THREADS);
  log(`  throwaway engine pid ${engine.remotePid} seed ${engine.seed}`);
  let roundsOk = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      const bgsId = `race-${round}`;
      const started = await engine.sendAndAwait(
        {
          type: "start_game_session",
          bgsId,
          botId: "probe",
          config: startConfig(),
        },
        "game_session_started",
      );
      if (started.success !== true) {
        throw new Error(`session ${bgsId} did not start`);
      }

      // Both in flight together. Either order is legal; neither may crash the
      // engine or go unanswered.
      await engine.write({ type: "evaluate_position", bgsId, expectedPly: 0 });
      await engine.write({ type: "end_game_session", bgsId });

      const deadline = Date.now() + TIMEOUT_MS;
      let evaluates = 0;
      let ends = 0;
      let incoherent = 0;
      for (let i = 0; i < 2; i++) {
        const response = await engine.readLine(deadline);
        if (response === "timeout") {
          log(
            `  TIMEOUT in round ${round} (${roundsOk} rounds clean before it)`,
          );
          reportShutdown("shutdown", await engine.shutdown());
          log(`  VERDICT: FAIL`);
          return false;
        }
        if (response === "eof") {
          log(
            `  ENGINE EXITED in round ${round} (${roundsOk} rounds clean before it)  <-- CRASH`,
          );
          reportShutdown("shutdown", await engine.shutdown());
          log(`  VERDICT: FAIL`);
          return false;
        }
        if (String(response.bgsId) !== bgsId) {
          incoherent++;
          log(
            `  WRONG bgsId in round ${round}: ${JSON.stringify(response).slice(0, 160)}`,
          );
          continue;
        }
        const type = String(response.type);
        if (type === "evaluate_response") {
          evaluates++;
          // Coherent either way: a real move, or an explicit reason it has none.
          const move =
            typeof response.bestMove === "string" ? response.bestMove : "";
          const err = typeof response.error === "string" ? response.error : "";
          if (response.success === true ? move === "" : err === "") {
            incoherent++;
            log(
              `  INCOHERENT evaluate in round ${round}: ${JSON.stringify(response).slice(0, 160)}`,
            );
          }
        } else if (type === "game_session_ended") {
          ends++;
          // Ending the session we just created must SUCCEED, whether or not the
          // evaluate pinned it first. A failed end would mean the session went
          // missing, which is the very thing this race is testing for.
          if (response.success !== true) {
            incoherent++;
            log(
              `  FAILED end in round ${round}: ${JSON.stringify(response).slice(0, 160)}`,
            );
          }
        } else {
          incoherent++;
          log(`  UNEXPECTED type in round ${round}: ${type}`);
        }
      }
      if (evaluates === 1 && ends === 1 && incoherent === 0) roundsOk++;
    }

    log(
      `  RESULT: ${roundsOk}/${rounds} rounds with exactly one coherent evaluate and one end`,
    );
    const shutdown = await engine.shutdown();
    reportShutdown("shutdown", shutdown);
    const ok = roundsOk === rounds && shutdown.natural && shutdown.reapComplete;
    log(`  VERDICT: ${ok ? "PASS" : "FAIL"}`);
    return ok;
  } catch (error) {
    log(`  THREW ${String(error)}`);
    reportShutdown("shutdown", await engine.shutdown());
    log(`  VERDICT: FAIL`);
    return false;
  }
};

/**
 * One sequential evaluate per --samples value, one engine process each.
 *
 * The SAMPLE RESULT is reported rather than judged: this is the S-SAMPLES
 * diagnostic, where "No legal move available" at a low sample count IS the
 * finding, not a failure.
 *
 * INFRASTRUCTURE is judged, though. A session that will not start, an evaluate
 * that never arrives, or an engine that has to be forced down are all real
 * failures, and returning true regardless would let a broken probe look like a
 * clean sweep of interesting data.
 */
const runBand = async () => {
  const values = flag("values", "1,2,4,8,112,1000").split(",").map(Number);
  log(
    `BAND over --samples ${values.join(",")} (${WIDTH}x${HEIGHT} ${VARIANT})`,
  );
  let infrastructureOk = true;
  for (const samples of values) {
    let engine: Awaited<ReturnType<typeof openEngine>> | undefined;
    try {
      engine = await openEngine(samples, THREADS);
      const bgsId = `band-${samples}`;
      const started = await engine.sendAndAwait(
        {
          type: "start_game_session",
          bgsId,
          botId: "probe",
          config: startConfig(),
        },
        "game_session_started",
      );
      if (started.success !== true) {
        infrastructureOk = false;
        log(`  samples=${String(samples).padStart(5)} SESSION DID NOT START`);
      }
      const response = await engine.sendAndAwait(
        { type: "evaluate_position", bgsId, expectedPly: 0 },
        "evaluate_response",
      );
      // success=false here is DATA, not an infrastructure failure.
      log(
        `  samples=${String(samples).padStart(5)} seed=${engine.seed} ` +
          `success=${response.success} bestMove=${JSON.stringify(response.bestMove)} ` +
          `eval=${response.evaluation} error=${JSON.stringify(response.error)}`,
      );
    } catch (error) {
      // A launch failure, a timeout, or a missing/mismatched response.
      infrastructureOk = false;
      log(`  samples=${String(samples).padStart(5)} THREW ${String(error)}`);
    } finally {
      if (engine) {
        const shutdown = await engine.shutdown();
        reportShutdown(`samples=${samples} shutdown`, shutdown);
        if (!shutdown.natural || !shutdown.reapComplete) {
          infrastructureOk = false;
        }
      }
    }
  }
  log(`  VERDICT: ${infrastructureOk ? "PASS" : "FAIL"} (infrastructure only)`);
  return infrastructureOk;
};

/**
 * Prove the identity marker is usable BEFORE launching anything.
 *
 * This boundary has already been got wrong once - an earlier version generated
 * values around 7.9e9, which gflags would have rejected as a uint32 - and it is
 * easy to reintroduce, because JavaScript numbers happily exceed the flag's
 * range. Cheap to check, expensive to discover from a confusing engine failure.
 */
const preflightSeed = () => {
  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const seed = nextSeed();
    assertUint32Seed(seed);
    if (seed === 0 || seed === 42) {
      throw new Error(`seed generator produced a reserved value: ${seed}`);
    }
    samples.push(seed);
  }
  const distinct = new Set(samples).size;
  log(
    `preflight: 1000 seeds all integers in [0, ${UINT32_MAX}], ${distinct} distinct, ` +
      `min=${Math.min(...samples)} max=${Math.max(...samples)}`,
  );
};

const main = async () => {
  preflightSeed();
  let ok: boolean;
  if (SCENARIO === "corpus") ok = await runCorpus(SESSIONS, THREADS);
  else if (SCENARIO === "ladder") ok = await runLadder();
  else if (SCENARIO === "race") ok = await runRace(ROUNDS);
  else if (SCENARIO === "band") ok = await runBand();
  else throw new Error(`unknown --scenario ${SCENARIO}`);
  if (!ok) process.exitCode = 1;
};

await main();
