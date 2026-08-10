/**
 * A fake engine that comes up healthy and dies later, used by
 * engine-failure.test.ts.
 *
 * It outlives the client's startup grace window on purpose, so it is judged
 * healthy, gets advertised, and only then dies. That is the case Nil decided
 * with option A: the client withholds just this bot and re-attaches, and the
 * server carries the other bots' games forward.
 *
 * Without this fixture the whole post-window path would be untested — the
 * startup window catches dying-engine.ts long before anyone can advertise it.
 */

export const FIXTURE = "late-dying-engine";

const LIFETIME_MS = 2500;

const RESPONSE_TYPE: Record<string, string> = {
  start_game_session: "game_session_started",
  end_game_session: "game_session_ended",
  evaluate_position: "evaluate_response",
  apply_move: "move_applied",
};

setTimeout(() => {
  process.stderr.write("late-dying-engine: losing the GPU, exiting\n");
  process.exit(4);
}, LIFETIME_MS);

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const req = JSON.parse(line) as { type: string; bgsId: string };
    const type = RESPONSE_TYPE[req.type];
    if (!type) continue;
    process.stdout.write(
      JSON.stringify({
        type,
        bgsId: req.bgsId,
        success: true,
        error: "",
        ply: 0,
        bestMove: "a1",
        evaluation: 0,
      }) + "\n",
    );
  }
}
