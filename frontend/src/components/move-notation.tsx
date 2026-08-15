import { assetUrl } from "@/lib/asset-url";
import { moveNotationDisplayParts } from "@/lib/move-notation-display";

interface MoveNotationProps {
  notation: string;
  useAnimalIcons: boolean;
}

export function MoveNotation({ notation, useAnimalIcons }: MoveNotationProps) {
  const parts = moveNotationDisplayParts(notation, useAnimalIcons);

  return (
    <span
      aria-label={notation}
      className="inline-flex items-center justify-center"
    >
      {parts.map((part, index) =>
        "icon" in part ? (
          <span key={index} className="inline-flex items-center">
            <img
              src={assetUrl(`/pawns/animal-cycle/${part.icon}.svg`)}
              alt=""
              aria-hidden="true"
              className="inline-block size-[1.15em] shrink-0 invert dark:invert-0"
            />
            <span>{part.text}</span>
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}
