/**
 * Minimal fake V3 engine used by engine-runner.test.ts.
 *
 * Reads JSON-line requests on stdin and writes matching responses on stdout,
 * mirroring the real long-lived engine's transport. evaluate_position responses
 * are deliberately delayed to simulate a slow MCTS search — this opens the
 * collision window with a concurrently-arriving end_game_session, which is the
 * exact scenario the request-collision fix targets.
 */

const RESPONSE_TYPE: Record<string, string> = {
  start_game_session: "game_session_started",
  end_game_session: "game_session_ended",
  evaluate_position: "evaluate_response",
  apply_move: "move_applied",
};

// How long (ms) each request type takes to answer. Slow evaluations are what
// keep a request in flight while an end_game_session arrives for the same bgsId.
const DELAY_MS: Record<string, number> = {
  evaluate_position: 150,
};

function respond(req: { type: string; bgsId: string; expectedPly?: number }) {
  const type = RESPONSE_TYPE[req.type];
  if (!type) return;
  const res: Record<string, unknown> = {
    type,
    bgsId: req.bgsId,
    success: true,
    error: "",
  };
  if (type === "evaluate_response") {
    res.ply = req.expectedPly ?? 0;
    res.bestMove = "a1";
    res.evaluation = 0;
  }
  if (type === "move_applied") {
    res.ply = req.expectedPly ?? 0;
  }
  process.stdout.write(JSON.stringify(res) + "\n");
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    const delay = DELAY_MS[req.type] ?? 0;
    if (delay > 0) {
      setTimeout(() => respond(req), delay);
    } else {
      respond(req);
    }
  }
}
