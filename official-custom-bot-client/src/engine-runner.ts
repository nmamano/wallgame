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

import { spawn } from "bun";
import type { EngineRequestV3, EngineResponseV3 } from "../../shared/custom-bot/engine-api";
import { logger } from "./logger";

/**
 * Parse a command string into arguments, handling quotes
 */
function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

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
  private proc: ReturnType<typeof spawn<{ cmd: string[]; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }>>;
  private stdin: import("bun").FileSink;
  private pendingRequests: Map<string, {
    resolve: (response: EngineResponseV3) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private isAlive: boolean = true;
  private lineBuffer: string = "";

  private constructor(proc: ReturnType<typeof spawn<{ cmd: string[]; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }>>) {
    this.proc = proc;
    this.stdin = proc.stdin;

    // Start reading stdout for responses
    this.readResponses();

    // Handle process exit
    proc.exited.then((exitCode) => {
      logger.info(`Engine process exited with code ${exitCode}`);
      this.isAlive = false;
      // Reject all pending requests
      for (const [bgsId, resolver] of this.pendingRequests) {
        resolver.reject(new Error(`Engine process exited with code ${exitCode}`));
      }
      this.pendingRequests.clear();
    });
  }

  /**
   * Spawn a new engine process.
   */
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
    (async () => {
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
      response = JSON.parse(line);
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

    // Find and resolve the pending request
    const resolver = this.pendingRequests.get(bgsId);
    if (resolver) {
      this.pendingRequests.delete(bgsId);
      resolver.resolve(response);
    } else {
      logger.warn(`No pending request for bgsId: ${bgsId}`);
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

    // Check for duplicate pending request
    if (this.pendingRequests.has(bgsId)) {
      throw new Error(`Already have pending request for bgsId: ${bgsId}`);
    }

    // Create promise for response
    const responsePromise = new Promise<EngineResponseV3>((resolve, reject) => {
      this.pendingRequests.set(bgsId, { resolve, reject });
    });

    // Write JSON line to stdin
    const json = JSON.stringify(request) + "\n";
    logger.debug(`Sending to engine: ${json.trim()}`);

    const encoder = new TextEncoder();
    this.stdin.write(encoder.encode(json));

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
        this.stdin.end();
      } catch {
        // Ignore stdin close errors
      }
      try {
        this.proc.kill();
      } catch {
        // Ignore kill errors
      }
      // Reject all pending requests
      for (const [bgsId, resolver] of this.pendingRequests) {
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
export async function spawnEngine(engineCommand: string): Promise<EngineProcess> {
  return EngineProcess.spawn(engineCommand);
}
