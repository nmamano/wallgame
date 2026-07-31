/**
 * Computes engine verdicts for the generated custom-setup candidates and
 * writes them to shared/domain/generated-custom-setup-verdicts.json.
 *
 * Two rules decide a candidate, both from the SAME single evaluate response:
 * the best first move may improve the mover's goal distance by at most 1, and
 * the mover must be decisively winning (MIN_MOVER_EVALUATION). The evaluation
 * was always in the response and used to be discarded — which is how six
 * unwinnable puzzles reached production.
 *
 * Because the engine is stochastic, the run prints an OLD-vs-NEW audit against
 * the currently committed artifact and flags every candidate near the
 * threshold. Read both before committing a regenerated artifact: a keep flip
 * changes the canonical generated set.
 *
 * The engine is driven OFFLINE on the desktop over an ssh pipe — the same
 * deep_ww_bgs_engine binary, model, and sample settings that serve PuzzleBot
 * in production, but in a throwaway process. Production is deliberately not
 * used: a filter run against the live eval path once segfaulted the serving
 * engine (2026-07-26, exit 139) and took PuzzleBot down for everyone.
 *
 * Requests are sent STRICTLY ONE AT A TIME, awaiting each response: the
 * engine schedules request handlers on its thread pool and blockingWaits
 * coroutines on that same pool, so pumping requests in bulk starves the pool
 * and deadlocks it (bgs_engine_main.cpp).
 *
 * Fail-loud: per-candidate response timeout; an engine crash, timeout, or
 * mismatched response aborts the run. The artifact is written atomically
 * (temp file + rename) only after the full run self-validates, so an
 * existing good artifact can never be truncated or partially overwritten.
 *
 * Usage: bun scripts/filter-puzzle-candidates.ts [--ssh user@gpu-host]
 *        (or set WALLGAME_SSH_TARGET instead of passing --ssh)
 */

import { spawn } from "bun";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateCustomSetupCandidates } from "../shared/domain/generated-custom-setup-candidates";
import {
  computeBestMoveDelta,
  keepVerdict,
  moverEvaluation,
  isValidEvaluation,
  applyCandidateVerdicts,
  evaluationInputKey,
  MIN_MOVER_EVALUATION,
  type CandidateVerdict,
  type CandidateVerdictFile,
} from "../shared/domain/custom-setup-verdicts";
import committedVerdicts from "../shared/domain/generated-custom-setup-verdicts.json";

/**
 * How close to the threshold counts as "rerun this one and look again".
 *
 * Sized from MEASURED noise, not intuition. One position read 0.691, 0.715
 * and 0.757 across three independent evaluations, so the band has to be
 * comfortably wider than that spread AND wide enough that a candidate sitting
 * at the top of it is still flagged: at 0.1 a 0.757 reading would fall 0.107
 * from the threshold and go unexamined.
 *
 * This is only an AUDIT TRIGGER. It is not part of the keep rule, a flagged
 * candidate is not rejected, and a rerun never rewrites the artifact — the
 * single recorded evaluation decides the committed artifact, and the band
 * exists to force human review of noisy boundary cases.
 */
const NEAR_THRESHOLD = 0.15;

// The GPU box is deployment-specific, and this repo is public, so it is not
// hardcoded. Set WALLGAME_SSH_TARGET once in your shell profile, or pass
// --ssh <user@host> per run.
const sshArgIndex = process.argv.indexOf("--ssh");
const SSH_TARGET =
  sshArgIndex >= 0
    ? process.argv[sshArgIndex + 1]
    : (process.env.WALLGAME_SSH_TARGET ?? "");
if (
  sshArgIndex >= 0 &&
  (!SSH_TARGET || SSH_TARGET.trim() === "" || SSH_TARGET.startsWith("--"))
) {
  throw new Error("--ssh requires a nonempty host value");
}
if (!SSH_TARGET) {
  throw new Error(
    "No ssh target. Set WALLGAME_SSH_TARGET=<user@host> or pass --ssh <user@host>.",
  );
}

const ENGINE_MODEL = "tf_curriculum_model_73.trt";
const ENGINE_SAMPLES = 5000;
const ENGINE_PARALLEL = 128;
const ENGINE_CMD =
  `cd ~/nil/wallgame/official-custom-bot-client && exec nice -n15 ` +
  `../deep-wallwars/build-tests/deep_ww_bgs_engine ` +
  `--model ../deep-wallwars/models_serving/${ENGINE_MODEL} ` +
  `--samples ${ENGINE_SAMPLES} --parallel_samples ${ENGINE_PARALLEL} ` +
  `--thread_pool_size 4 2>/dev/null`;

const RESPONSE_TIMEOUT_MS = 120_000;

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

const main = async () => {
  const proc = spawn(
    ["ssh", "-o", "ConnectTimeout=15", SSH_TARGET, ENGINE_CMD],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const reader = proc.stdout.getReader();
  let buffer = "";

  /** Read one JSON line from the engine within the deadline. */
  const readLine = async (
    deadline: number,
  ): Promise<Record<string, unknown>> => {
    for (;;) {
      const newlineAt = buffer.indexOf("\n");
      if (newlineAt >= 0) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        if (line.trim() === "") continue;
        return JSON.parse(line) as Record<string, unknown>;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("engine response timeout — no artifact written");
      }
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => clearTimeout(timeoutId));
      if (chunk === "timeout") {
        throw new Error("engine response timeout — no artifact written");
      }
      if (chunk.done) {
        throw new Error("engine process exited (crash?) — no artifact written");
      }
      buffer += new TextDecoder().decode(chunk.value);
    }
  };

  /**
   * Send one request and await ITS response, validating the response type
   * and bgsId (rather than accepting the next arbitrary JSON object).
   */
  const sendAndAwait = async (
    msg: { type: string; bgsId: string } & Record<string, unknown>,
    expectedResponseType: string,
  ): Promise<Record<string, unknown>> => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    await proc.stdin.flush();
    const response = await readLine(Date.now() + RESPONSE_TIMEOUT_MS);
    if (
      response.type !== expectedResponseType ||
      response.bgsId !== msg.bgsId
    ) {
      throw new Error(
        `unexpected engine response to ${msg.type} (${msg.bgsId}): ` +
          JSON.stringify(response).slice(0, 200),
      );
    }
    if (response.success === false) {
      throw new Error(
        `${msg.type} failed for ${msg.bgsId}: ${String(response.error)}`,
      );
    }
    return response;
  };

  try {
    const candidates = generateCustomSetupCandidates();
    const verdicts: CandidateVerdict[] = [];

    for (const candidate of candidates) {
      const bgsId = `filter-${candidate.id}`;
      await sendAndAwait(
        {
          type: "start_game_session",
          bgsId,
          botId: "dw-puzzle",
          config: {
            variant: candidate.config.variant,
            boardWidth: candidate.config.boardWidth,
            boardHeight: candidate.config.boardHeight,
            initialState: candidate.config.variantConfig,
          },
        },
        "game_session_started",
      );

      const evaluated = await sendAndAwait(
        { type: "evaluate_position", bgsId, expectedPly: 0 },
        "evaluate_response",
      );
      const bestMove = evaluated.bestMove;
      if (typeof bestMove !== "string" || evaluated.ply !== 0) {
        throw new Error(
          `evaluate_response malformed for ${candidate.id}: ` +
            JSON.stringify(evaluated).slice(0, 200),
        );
      }
      // Range-checked here so a malformed engine number can never reach the
      // artifact, rather than only being caught when the artifact is read.
      if (!isValidEvaluation(evaluated.evaluation)) {
        throw new Error(
          `evaluate_response evaluation for ${candidate.id} is not a number ` +
            `in [-1,1]: ${JSON.stringify(evaluated).slice(0, 200)}`,
        );
      }
      const evaluation = evaluated.evaluation;

      await sendAndAwait(
        { type: "end_game_session", bgsId },
        "game_session_ended",
      );

      const { beforeDistance, afterDistance, delta } = computeBestMoveDelta(
        candidate,
        bestMove,
      );
      const moverEval = moverEvaluation(evaluation, candidate.humanPlaysAs);
      const keep = keepVerdict({ delta, moverEval });
      verdicts.push({
        candidateId: candidate.id,
        fingerprint: evaluationInputKey(candidate),
        bestMove,
        beforeDistance,
        afterDistance,
        delta,
        evaluation,
        keep,
      });
      log(
        `${candidate.id}: best ${bestMove}, d ${beforeDistance}->${afterDistance} ` +
          `(delta ${delta}), mover eval ${moverEval.toFixed(3)} ` +
          `=> ${keep ? "KEEP" : "REJECT"}`,
      );
    }

    const file: CandidateVerdictFile = {
      evaluatedAt: new Date().toISOString(),
      origin: `offline:${SSH_TARGET}`,
      botCompositeId: "offline:dw-puzzle",
      botName:
        `deep_ww_bgs_engine ${ENGINE_MODEL} ` +
        `samples=${ENGINE_SAMPLES} parallel=${ENGINE_PARALLEL} ` +
        `(PuzzleBot's production configuration, run offline)`,
      verdicts,
    };

    // OLD-vs-NEW audit. The engine is stochastic, so a regenerated artifact
    // can legitimately differ; what must never happen silently is a change to
    // which candidates are kept. Every flip is listed explicitly.
    const previous = new Map(
      (committedVerdicts as { verdicts: Partial<CandidateVerdict>[] }).verdicts
        .filter((v): v is CandidateVerdict => typeof v.candidateId === "string")
        .map((v) => [v.candidateId, v]),
    );
    const flips: string[] = [];
    const nearThreshold: string[] = [];
    log("audit (old -> new):");
    for (const verdict of verdicts) {
      const candidate = candidates.find((c) => c.id === verdict.candidateId)!;
      const moverEval = moverEvaluation(
        verdict.evaluation,
        candidate.humanPlaysAs,
      );
      const old = previous.get(verdict.candidateId);
      const oldEval =
        old && isValidEvaluation(old.evaluation)
          ? moverEvaluation(old.evaluation, candidate.humanPlaysAs).toFixed(3)
          : "n/a";
      log(
        `  ${verdict.candidateId}: move ${old?.bestMove ?? "n/a"} -> ${verdict.bestMove}, ` +
          `delta ${old?.delta ?? "n/a"} -> ${verdict.delta}, ` +
          `mover eval ${oldEval} -> ${moverEval.toFixed(3)}, ` +
          `keep ${String(old?.keep ?? "n/a")} -> ${String(verdict.keep)}`,
      );
      if (old && old.keep !== verdict.keep) {
        flips.push(
          `${verdict.candidateId}: keep ${String(old.keep)} -> ${String(verdict.keep)}`,
        );
      }
      if (Math.abs(moverEval - MIN_MOVER_EVALUATION) <= NEAR_THRESHOLD) {
        nearThreshold.push(
          `${verdict.candidateId}: mover eval ${moverEval.toFixed(3)} ` +
            `(threshold ${MIN_MOVER_EVALUATION})`,
        );
      }
    }
    log(
      flips.length === 0
        ? "KEEP FLIPS: none"
        : `KEEP FLIPS (${flips.length}) — each one changes the canonical set:`,
    );
    for (const flip of flips) log(`  ${flip}`);
    log(
      nearThreshold.length === 0
        ? `NEAR THRESHOLD (within ${NEAR_THRESHOLD}): none`
        : `NEAR THRESHOLD (within ${NEAR_THRESHOLD}) — rerun these in a fresh ` +
            `session and compare, do not average:`,
    );
    for (const near of nearThreshold) log(`  ${near}`);

    // Self-check, then atomic write: the existing artifact is replaced only
    // by a fully validated new one.
    const kept = applyCandidateVerdicts(candidates, file);
    const outPath = join(
      import.meta.dir,
      "../shared/domain/generated-custom-setup-verdicts.json",
    );
    const tmpPath = `${outPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(file, null, 2) + "\n");
    renameSync(tmpPath, outPath);
    log(
      `wrote ${outPath}: ${verdicts.length} verdicts, ${kept.length} kept, ` +
        `${verdicts.length - kept.length} rejected`,
    );
  } finally {
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
};

await main();
