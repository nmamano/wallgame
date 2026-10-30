import { PORTAL_RATED_UNAVAILABLE } from "./embedded-mode";

/**
 * What a guest sees at the open seat of a rated game. On wallgame.io they are
 * offered an account; in a portal frame (lib/embedded-mode.ts) no account can
 * be made, so the seat only says why it is closed and offers nothing to click.
 */
export interface RatedSeatPrompt {
  waitingMessage: string;
  action: { label: string; description: string; href: string } | null;
}

export const ratedSeatPrompt = (embedded: boolean): RatedSeatPrompt =>
  embedded
    ? {
        waitingMessage: `This game is rated. ${PORTAL_RATED_UNAVAILABLE}`,
        action: null,
      }
    : {
        waitingMessage:
          "This game is rated. Rated games are only played between logged-in players.",
        action: {
          label: "Create an account",
          description:
            "This game is rated. Sign up or log in to take the seat - you can still watch as a spectator.",
          href: "/api/register",
        },
      };
