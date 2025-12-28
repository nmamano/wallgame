/**
 * Engine Runner
 *
 * Handles spawning and communicating with external engine processes.
 * Each decision prompt spawns a new process that reads JSON from stdin
 * and writes JSON to stdout.
 */

import { spawn } from "bun";
import type { EngineRequest, EngineResponse } from "./engine-api";
import { logger } from "./logger";

export interface EngineRunnerOptions {
  engineCommand: string;
  /** Timeout in milliseconds for engine execution */
  timeoutMs?: number;
}

export interface EngineResult {
  success: boolean;
  response?: EngineResponse;
  error?: string;
}

/**
 * Run the engine with the given request
 *
 * The engine is spawned as a new process:
 * 1. Write JSON request to stdin
 * 2. Close stdin
 * 3. Read JSON response from stdout
 * 4. Kill if timeout exceeded
 */
export async function runEngine(
  options: EngineRunnerOptions,
  request: EngineRequest,
): Promise<EngineResult> {
  const { engineCommand, timeoutMs = 30000 } = options;
  const requestJson = JSON.stringify(request);

  logger.debug("Running engine:", engineCommand);
  logger.debug("Request:", requestJson);

  // Parse the command - handle shell-style quoting
  const args = parseCommand(engineCommand);
  if (args.length === 0) {
    return { success: false, error: "Empty engine command" };
  }

  const cmd = args[0];
  const cmdArgs = args.slice(1);

  let proc: ReturnType<typeof spawn> | undefined;

  try {
    proc = spawn({
      cmd: [cmd, ...cmdArgs],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdinPipe = proc.stdin as import("bun").FileSink;
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;

    // Write request to stdin and close
    const encoder = new TextEncoder();
    const requestBytes = encoder.encode(requestJson);
    stdinPipe.write(requestBytes);
    stdinPipe.end();

    // Set up timeout with cleanup
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Engine timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Read stdout
    const outputPromise = (async () => {
      const chunks: Uint8Array[] = [];
      const reader = stdoutStream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }

      return Buffer.concat(chunks).toString("utf-8");
    })();

    // Read stderr for logging
    const stderrPromise = (async () => {
      const chunks: Uint8Array[] = [];
      const reader = stderrStream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }

      return Buffer.concat(chunks).toString("utf-8");
    })();

    // Wait for output or timeout
    let output: string;
    try {
      output = await Promise.race([outputPromise, timeoutPromise]);
    } finally {
      // Clear the timeout to prevent timer leak
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    const stderrOutput = await Promise.race([
      stderrPromise,
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 100)),
    ]);

    if (stderrOutput) {
      logger.debug("Engine stderr:", stderrOutput);
    }

    // Wait for process to exit
    const exitCode = await proc.exited;
    logger.debug("Engine exit code:", exitCode);

    if (!output.trim()) {
      return { success: false, error: "Engine produced no output" };
    }

    // Parse JSON response
    let response: EngineResponse;
    try {
      response = JSON.parse(output.trim());
    } catch (parseError) {
      return {
        success: false,
        error: `Failed to parse engine output: ${parseError}`,
      };
    }

    // Validate response structure
    if (
      !response.engineApiVersion ||
      !response.requestId ||
      !response.response
    ) {
      return {
        success: false,
        error: "Invalid engine response structure",
      };
    }

    if (response.requestId !== request.requestId) {
      return {
        success: false,
        error: `Request ID mismatch: expected ${request.requestId}, got ${response.requestId}`,
      };
    }

    return { success: true, response };
  } catch (error) {
    // Kill the process on error
    if (proc) {
      try {
        proc.kill();
      } catch {
        // Ignore kill errors
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

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
 * Calculate timeout based on remaining clock time
 */
export function calculateEngineTimeout(
  timeLeftMs: number,
  minTimeoutMs: number = 1000,
  bufferMs: number = 500,
): number {
  // Leave some buffer for network latency
  const available = Math.max(minTimeoutMs, timeLeftMs - bufferMs);
  return available;
}
