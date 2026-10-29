import { describe, expect, test } from "bun:test";
import type { PlayerId } from "../../shared/domain/game-types";
import { scoreGame, type EngineLink, type GameToScore } from "./engine-eval";

/**
 * An engine that scores position k as k / 10 and refuses the position
 * `refuse` (or times out there when `timeout`); it records every request.
 */
const fakeLink = ({ refuse = -1, timeout = false } = {}) => {
  const sent: Record<string, unknown>[] = [];
  const link = {
    request: (message: Record<string, unknown>) => {
      sent.push(message);
      if (message.type !== "evaluate_position") {
        return Promise.resolve({ success: true });
      }
      const ply = message.expectedPly as number;
      if (ply === refuse) {
        return timeout
          ? Promise.reject(new Error("engine timeout on evaluate_position"))
          : Promise.resolve({ success: false, error: "terminal" });
      }
      return Promise.resolve({
        success: true,
        ply,
        evaluation: ply / 10,
        bestMove: ply === 1 ? "" : `Cb${ply + 1}`,
      });
    },
  };
  return { link: link as unknown as EngineLink, sent };
};

const game = (winner: PlayerId | null): GameToScore => ({
  gameId: "G1",
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  initialState: undefined,
  moves: ["Ce4", "Ce5", "Cd4"],
  winner,
});

describe("scoreGame (the evaluation bar's numbers for one game)", () => {
  test("one value per position, and the session always ends", async () => {
    const { link, sent } = fakeLink();
    expect(await scoreGame(link, game(1))).toEqual({
      evaluations: [0, 0.1, 0.2, 0.3],
      bestMoves: ["Cb1", null, "Cb3", "Cb4"],
      finalFromResult: false,
    });
    expect(sent[0]).toMatchObject({
      type: "start_game_session",
      bgsId: "daily-G1",
    });
    expect(
      sent.filter((m) => m.type === "apply_move").map((m) => m.move),
    ).toEqual(["Ce4", "Ce5", "Cd4"]);
    expect(sent.at(-1)).toEqual({
      type: "end_game_session",
      bgsId: "daily-G1",
    });
  });

  test("a final position the engine refuses takes the game's winner", async () => {
    const final = async (winner: PlayerId | null) =>
      (
        await scoreGame(fakeLink({ refuse: 3 }).link, game(winner))
      ).evaluations.at(-1);
    expect(await final(1)).toBe(1);
    expect(await final(2)).toBe(-1);
    expect(await final(null)).toBe(0);
    expect(
      (await scoreGame(fakeLink({ refuse: 3 }).link, game(1))).bestMoves,
    ).toEqual(["Cb1", null, "Cb3", null]);
  });

  test("a timeout, or a refusal before the end, is no verdict: it throws", async () => {
    const failure = (link: EngineLink) =>
      scoreGame(link, game(1)).then(
        () => "resolved",
        (error: unknown) => String(error),
      );
    expect(
      await failure(fakeLink({ refuse: 3, timeout: true }).link),
    ).toContain("engine timeout");
    expect(await failure(fakeLink({ refuse: 2 }).link)).toContain(
      "evaluate ply 2: terminal",
    );
  });
});
