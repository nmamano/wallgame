import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Share2 } from "lucide-react";
import {
  puzzleShareUrl,
  type PuzzleKind,
} from "../../../shared/domain/puzzle-links";

interface SharePuzzleButtonProps {
  kind: PuzzleKind;
  id: string;
  /** Named in the confirmation and in the accessible label. */
  puzzleName: string;
  /** `icon` for the listing cards, `default` for a page header. */
  size?: "icon" | "default";
}

/**
 * Copies a link that lets someone else PLAY this puzzle.
 *
 * Deliberately not the game share link: that one points at a single
 * playthrough, so a friend opening it arrives as a spectator of a game already
 * in progress. This points at the puzzle, and whoever opens it gets their own
 * attempt at it.
 *
 * It COPIES, always. It used to hand off to the Web Share sheet wherever the
 * browser offered one, which reads well on a phone but means the same button
 * does two different things depending on the device — on desktop Chrome and
 * Edge it opened an OS share menu nobody asked for (Nil, 2026-08-04: "the
 * share button should just copy url to clipboard, not open whatever menu it
 * opens now"). One behaviour everywhere is worth more than the phone nicety.
 */
export function SharePuzzleButton({
  kind,
  id,
  puzzleName,
  size = "icon",
}: SharePuzzleButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The confirmation is on a timer, and a card can unmount while it runs (the
  // listing re-sorts under you when the sort mode changes).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleShare = async () => {
    if (typeof window === "undefined") return;
    const url = puzzleShareUrl(kind, id, window.location.origin);

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied outright (insecure context, or a
      // permission the user has turned off). Saying nothing would look like a
      // dead button, so surface the link and let them copy it by hand.
      window.prompt("Copy this link:", url);
    }
  };

  const label = copied ? "Link copied" : `Share ${puzzleName}`;

  if (size === "icon") {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
        onClick={() => void handleShare()}
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
        ) : (
          <Share2 className="h-4 w-4" />
        )}
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      title={label}
      onClick={() => void handleShare()}
    >
      {copied ? (
        <>
          <Check className="mr-1 h-4 w-4 text-green-600 dark:text-green-500" />
          Copied
        </>
      ) : (
        <>
          <Share2 className="mr-1 h-4 w-4" />
          Share
        </>
      )}
    </Button>
  );
}
