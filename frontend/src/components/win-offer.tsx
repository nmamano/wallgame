import { Button } from "@/components/ui/button";
import type { WinOffer } from "@/hooks/use-win-offer";

/**
 * Nil's words, word for word (task B, ask 80141178, 2026-11-22). The text is
 * true because a sign-up links this browser's guest games to the account.
 */
const COPY = {
  win: { title: "You won! Keep this win.", button: "Save my win" },
  puzzle: { title: "Solved! Keep it.", button: "Save my solve" },
} as const;
const TEXT =
  "Make a free account to save this game and your history, pick a name, and play rated games.";

/**
 * The offer after a guest's win: the title and the button on one row, the
 * text under them across the full width. The same block serves the phone's
 * strip and the desktop end panel's result area, so the two cannot drift.
 */
export function WinOfferBlock({
  offer,
  buttonClassName,
}: {
  offer: WinOffer;
  /** The button size of the surrounding bar. */
  buttonClassName: string;
}) {
  const copy = COPY[offer.trigger];
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-bold lg:text-base">
          {copy.title}
        </h3>
        <Button
          size="sm"
          className={`shrink-0 ${buttonClassName}`}
          onClick={offer.handleSignUp}
        >
          {copy.button}
        </Button>
      </div>
      <p className="text-xs leading-tight text-muted-foreground">{TEXT}</p>
    </div>
  );
}
