/**
 * Engine Runner (V3)
 *
 * Handles spawning and communicating with external engine processes.
 *
 * V3 Key Changes:
 * - Engine is a long-lived process (started once at startup)
 * - Communication via JSON-lines over stdin/stdout
 * - Each JSON message is on a single line
 * - Engine maintains state across messages (game sessions, MCTS trees)
 */

import { spawn, type Subprocess } from "bun";
import type {
  EngineRequestV3,
  EngineResponseV3,
} from "../../shared/custom-bot/engine-api";
import { logger } from "./logger";

/**
 * Maps each response type back to the request type it answers.
 *
 * The engine's responses carry a bgsId and a type but no request id, so the
 * client correlates a response to its pending request purely from those two
 * fields. Keying pendingRequests by (requestType, bgsId) lets multiple requests
 * for the SAME session be in flight at once (e.g. a slow evaluate_position and
 * an end_game_session), as long as they are of different types — which they
 * always are within a session's normal traffic. This table is what makes the
 * response routable back to the correct pending request.
 */
const REQUEST_TYPE_BY_RESPONSE_TYPE: Record<
  EngineResponseV3["type"],
  EngineRequestV3["type"]
> = {
  game_session_started: "start_game_session",
  game_session_ended: "end_game_session",
  evaluate_response: "evaluate_position",
  move_applied: "apply_move",
};

/**
 * Compose the pendingRequests map key. Request type comes first so the key is
 * unambiguous even if a bgsId ever contained the separator character: the
 * prefix up to the first separator is always one of the fixed request-type
 * literals, and everything after it is the full bgsId.
 */
function pendingKey(
  requestType: EngineRequestV3["type"],
  bgsId: string,
): string {
  return `${requestType}\0${bgsId}`;
}

/**
 * Parse a command string into arguments, handling quotes
 */
function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  // for-of yields whole code points where the old index loop yielded UTF-16
  // code units. The output is unchanged either way: a surrogate half matches
  // none of the delimiters below, so both forms concatenate it back into
  // `current` unmodified.
  for (const char of command) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * How many of the engine's most recent stderr lines to keep.
 *
 * One process serves every bot, so by the time a client notices an engine is
 * gone its last words are far up a log shared with three other engines. Keeping
 * them on the instance lets the "not advertising this bot" line carry the
 * engine's own explanation with it.
 */
const RETAINED_STDERR_LINES = 10;

/**
 * V3: Long-lived engine process that communicates via JSON-lines.
 *
 * The EngineProcess maintains a subprocess and handles async message passing.
 * Multiple BGS (Bot Game Sessions) can be handled by a single engine process.
 */
export class EngineProcess {
  // Subprocess<In, Out, Err> takes the three STREAM MODES. The earlier spelling
  // passed the whole options object as the first type argument, which is not
  // what the parameter means; it only compiled because the older @types/bun had
  // a looser constraint on it. With "pipe" in all three slots, `proc.stdin` is
  // a FileSink rather than `number | FileSink | undefined`.
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private stdin: import("bun").FileSink;
  // Keyed by (requestType, bgsId) via pendingKey(), NOT by bgsId alone, so that
  // more than one request per session can be in flight concurrently.
  private pendingRequests = new Map<
    string,
    {
      resolve: (response: EngineResponseV3) => void;
      reject: (error: Error) => void;
    }
  >();
  private isAlive = true;
  private lineBuffer = "";
  /** The bot this engine serves. Prefixes every line it produces. */
  private readonly label: string;
  /** Set once the process exits. Null while it is still running. */
  private exitCode: number | null = null;
  /** True once kill() ran, so a deliberate teardown is not read as a death. */
  private killed = false;
  private stderrTail: string[] = [];
  private exitHandlers: ((exitCode: number | null) => void)[] = [];
  private readonly stdoutFinished: Promise<void>;
  private readonly stderrFinished: Promise<void>;

  private constructor(proc: Subprocess<"pipe", "pipe", "pipe">, label: string) {
    this.proc = proc;
    this.stdin = proc.stdin;
    this.label = label;

    // Start reading stdout for responses
    this.stdoutFinished = this.readResponses();
    // ...and stderr, which is where the engine explains itself when it dies.
    this.stderrFinished = this.readStderr();

    // Handle process exit
    void proc.exited.then((exitCode) => {
      logger.info(
        `[${this.label}] engine process exited with code ${exitCode}`,
      );
      this.isAlive = false;
      this.exitCode = exitCode;
      // Reject all pending requests
      for (const [, resolver] of this.pendingRequests) {
        resolver.reject(
          new Error(`Engine process exited with code ${exitCode}`),
        );
      }
      this.pendingRequests.clear();

      // A deliberate kill is a shutdown, not a death. Firing the handlers for
      // it would make close() look like an engine failure and trigger the
      // re-attach path on the way out.
      if (this.killed) return;
      for (const handler of this.exitHandlers) handler(exitCode);
    });
  }

  /**
   * Read the engine's stderr.
   *
   * Two things changed here, and both are the point of board task 5f302c24.
   * This was logged at `debug` while the logger defaults to `info`, so every
   * line the engine wrote was captured and then dropped at the threshold — an
   * engine could die without leaving a word in the log. And chunks are now
   * split into lines: a read can carry several lines or half of one, so
   * logging the raw chunk interleaves four engines into an unreadable mess.
   */
  private async readStderr(): Promise<void> {
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const emit = (line: string) => {
      logger.info(`[${this.label}] engine: ${line}`);
      this.stderrTail.push(line);
      if (this.stderrTail.length > RETAINED_STDERR_LINES) {
        this.stderrTail.shift();
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trimEnd();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) emit(line);
        }
      }
      // A dying engine often writes its last line without a trailing newline,
      // and that line is the one worth having.
      const remainder = buffer.trim();
      if (remainder) emit(remainder);
    } catch (error) {
      logger.error(`[${this.label}] error reading engine stderr:`, error);
    }
  }

  /**
   * Spawn a new engine process.
   */
  // `async` with nothing awaited, kept on purpose. Dropping it would turn the
  // "Empty engine command" throw below from a rejected promise into a
  // synchronous one, which is a different thing for any caller that does not
  // await. The Promise return type is the published contract either way.
  // eslint-disable-next-line @typescript-eslint/require-await
  static async spawn(
    engineCommand: string,
    label: string,
  ): Promise<EngineProcess> {
    const args = parseCommand(engineCommand);
    if (args.length === 0) {
      throw new Error("Empty engine command");
    }

    const cmd = args[0];
    const cmdArgs = args.slice(1);

    logger.debug(`[${label}] spawning engine: ${cmd} ${cmdArgs.join(" ")}`);

    // Note for anyone reading this expecting a try/catch: a missing binary
    // makes this throw SYNCHRONOUSLY (ENOENT), which is one of the two failure
    // shapes the caller has to handle. The other is a process that spawns
    // cleanly and then exits, which shows up as `alive` going false rather than
    // as a throw. Neither is detectable here, so both are the caller's problem.
    const proc = spawn({
      cmd: [cmd, ...cmdArgs],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    return new EngineProcess(proc, label);
  }

  /**
   * Read JSON-lines responses from stdout.
   */
  private async readResponses(): Promise<void> {
    const stdoutStream = this.proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdoutStream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          this.lineBuffer += decoder.decode(value);

          // Process complete lines
          let newlineIndex: number;
          while ((newlineIndex = this.lineBuffer.indexOf("\n")) !== -1) {
            const line = this.lineBuffer.slice(0, newlineIndex).trim();
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

            if (line) {
              this.handleResponse(line);
            }
          }
        }
      }
    } catch (error) {
      logger.error("Error reading engine stdout:", error);
      this.isAlive = false;
    }
  }

  /**
   * Handle a JSON response line from the engine.
   */
  private handleResponse(line: string): void {
    logger.debug(`Engine response: ${line}`);

    let response: EngineResponseV3;
    try {
      response = JSON.parse(line) as EngineResponseV3;
    } catch (error) {
      logger.error(`Failed to parse engine response: ${line}`, error);
      return;
    }

    // Extract bgsId from response
    const bgsId = response.bgsId;
    if (!bgsId) {
      logger.error(`Response missing bgsId: ${line}`);
      return;
    }

    // Map the response type back to the request type it answers, then look up
    // the pending request under the same (requestType, bgsId) key used by send().
    const requestType = REQUEST_TYPE_BY_RESPONSE_TYPE[response.type];
    if (!requestType) {
      logger.error(`Response has unknown type: ${line}`);
      return;
    }
    const key = pendingKey(requestType, bgsId);

    // Find and resolve the pending request
    const resolver = this.pendingRequests.get(key);
    if (resolver) {
      this.pendingRequests.delete(key);
      resolver.resolve(response);
    } else {
      logger.warn(
        `No pending request for ${response.type} response (bgsId: ${bgsId})`,
      );
    }
  }

  /**
   * Send a request to the engine and wait for a response.
   */
  async send(request: EngineRequestV3): Promise<EngineResponseV3> {
    if (!this.isAlive) {
      throw new Error("Engine process is not running");
    }

    // Extract bgsId from request
    const bgsId = request.bgsId;
    if (!bgsId) {
      throw new Error("Request missing bgsId");
    }

    const key = pendingKey(request.type, bgsId);

    // Guard against a genuine collision: two in-flight requests of the SAME type
    // for the same session would be indistinguishable when their responses come
    // back (responses correlate only by type + bgsId). Different-type requests
    // for the same session no longer collide, since they have distinct keys.
    if (this.pendingRequests.has(key)) {
      throw new Error(
        `Already have pending ${request.type} request for bgsId: ${bgsId}`,
      );
    }

    // Create promise for response
    const responsePromise = new Promise<EngineResponseV3>((resolve, reject) => {
      this.pendingRequests.set(key, { resolve, reject });
    });

    // Write JSON line to stdin
    const json = JSON.stringify(request) + "\n";
    logger.debug(`Sending to engine: ${json.trim()}`);

    const encoder = new TextEncoder();
    void this.stdin.write(encoder.encode(json));

    return responsePromise;
  }

  /**
   * Kill the engine process.
   */
  kill(): void {
    this.killed = true;
    if (this.isAlive) {
      logger.debug(`[${this.label}] killing engine process`);
      this.isAlive = false;
      try {
        void this.stdin.end();
      } catch {
        // Ignore stdin close errors
      }
      try {
        this.proc.kill();
      } catch {
        // Ignore kill errors
      }
      // Reject all pending requests
      for (const [, resolver] of this.pendingRequests) {
        resolver.reject(new Error("Engine process killed"));
      }
      this.pendingRequests.clear();
    }
  }

  /**
   * Close stdin and wait for a clean engine exit.
   *
   * Strength runners use this instead of kill() so the engine can drain its
   * requests and publish final batching statistics. Callers must apply their
   * own deadline and fall back to kill() if the process does not exit.
   */
  async shutdown(): Promise<number> {
    if (this.pendingRequests.size > 0) {
      throw new Error(
        `Cannot shut down engine with ${this.pendingRequests.size} pending request(s)`,
      );
    }
    this.killed = true;
    if (this.isAlive) {
      void this.stdin.end();
    }
    const exitCode = await this.proc.exited;
    await Promise.all([this.stdoutFinished, this.stderrFinished]);
    if (exitCode !== 0) {
      throw new Error(`Engine process exited with code ${exitCode}`);
    }
    return exitCode;
  }

  /**
   * Check if the engine process is still alive.
   */
  get alive(): boolean {
    return this.isAlive;
  }

  /**
   * The process's exit code, or null while it is still running.
   *
   * Note what this is NOT: a readiness signal. An engine that is loading its
   * model for ten seconds is alive with a null exit code, and so is one wedged
   * forever on a lock. Only death is observable from out here.
   */
  get exitStatus(): number | null {
    return this.exitCode;
  }

  /** The engine's most recent stderr lines, oldest first. */
  recentStderr(): string[] {
    return [...this.stderrTail];
  }

  /**
   * Run `handler` when the process dies on its own.
   *
   * Deliberate kills do not count — see the `killed` flag. If the process has
   * ALREADY died, the handler runs immediately, which closes the window between
   * a caller checking `alive` and subscribing.
   */
  onExit(handler: (exitCode: number | null) => void): void {
    if (!this.isAlive && !this.killed) {
      handler(this.exitCode);
      return;
    }
    this.exitHandlers.push(handler);
  }
}

/**
 * Spawn a new engine process.
 * Convenience function that delegates to EngineProcess.spawn().
 */
export async function spawnEngine(
  engineCommand: string,
  label: string,
): Promise<EngineProcess> {
  return EngineProcess.spawn(engineCommand, label);
}
