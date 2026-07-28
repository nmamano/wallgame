/**
 * Ending a game durably: make it persistent BEFORE telling anyone it ended.
 *
 * The ordering is a real guarantee, not a nicety. Puzzle completion (S-G3) is
 * DERIVED from the persisted game row, so a client that hears "finished" and
 * immediately asks "what have I solved?" must not be able to beat the write —
 * otherwise a genuine solve is missing until some later refetch, which looks
 * exactly like a bug to the player.
 *
 * Every other finish path in `game-socket.ts` already persisted before
 * broadcasting; the bot-move path broadcast first, which is the race this
 * closes.
 *
 * A persistence failure must NOT swallow the broadcast: the game really has
 * ended, and leaving clients staring at a live board would be worse than a
 * missing history row. So the error is reported and the broadcast happens
 * regardless.
 */
export const persistThenBroadcastFinish = async (args: {
  persist: () => Promise<void>;
  broadcast: () => void;
  onPersistError: (error: unknown) => void;
}): Promise<void> => {
  try {
    await args.persist();
  } catch (error) {
    args.onPersistError(error);
  }
  args.broadcast();
};
