import type { PastGamePlayerKind } from "../../shared/contracts/games";

export const classifyPastGamePlayer = (
  playerConfigType: string,
  userId: number | null,
): PastGamePlayerKind => {
  if (playerConfigType === "bot" || playerConfigType === "custom bot") {
    return "bot";
  }
  return userId !== null ? "member" : "guest";
};
