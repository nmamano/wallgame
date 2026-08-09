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

  private constructor(proc: Subprocess<"pipe", "pipe", "pipe">) {
    this.proc = proc;
    this.stdin = proc.stdin;

    // Start reading stdout for responses
    void this.readResponses();

    // Handle process exit
    void proc.exited.then((exitCode) => {
      logger.info(`Engine process exited with code ${exitCode}`);
      this.isAlive = false;
      // Reject all pending requests
      for (const [, resolver] of this.pendingRequests) {
        resolver.reject(
          new Error(`Engine process exited with code ${exitCode}`),
        );
      }
      this.pendingRequests.clear();
    });
  }

  /**
   * Spawn a new engine process.
   */
  // `async` with nothing awaited, kept on purpose. Dropping it would turn the
  // "Empty engine command" throw below from a rejected promise into a
  // synchronous one, which is a different thing for any caller that does not
  // await. The Promise return type is the published contract either way.
  // eslint-disable-next-line @typescript-eslint/require-await
  static async spawn(engineCommand: string): Promise<EngineProcess> {
    const args = parseCommand(engineCommand);
    if (args.length === 0) {
      throw new Error("Empty engine command");
    }

    const cmd = args[0];
    const cmdArgs = args.slice(1);

    logger.debug(`Spawning engine: ${cmd} ${cmdArgs.join(" ")}`);

    const proc = spawn({
      cmd: [cmd, ...cmdArgs],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Log stderr output
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
    void (async () => {
      const reader = stderrStream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const text = decoder.decode(value);
          logger.debug(`Engine stderr: ${text.trim()}`);
        }
      }
    })();

    return new EngineProcess(proc);
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
    if (this.isAlive) {
      logger.debug("Killing engine process");
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
   * Check if the engine process is still alive.
   */
  get alive(): boolean {
    return this.isAlive;
  }
}

/**
 * Spawn a new engine process.
 * Convenience function that delegates to EngineProcess.spawn().
 */
export async function spawnEngine(
  engineCommand: string,
): Promise<EngineProcess> {
  return EngineProcess.spawn(engineCommand);
}
