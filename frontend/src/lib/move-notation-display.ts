export type AnimalNotationIcon = "cat" | "dog" | "elephant" | "mouse";

export type MoveNotationDisplayPart =
  | { text: string }
  | { icon: AnimalNotationIcon; text: string };

const animalByPrefix: Record<string, AnimalNotationIcon> = {
  C: "cat",
  D: "dog",
  E: "elephant",
  M: "mouse",
};

export const moveNotationDisplayParts = (
  notation: string,
  useAnimalIcons: boolean,
): MoveNotationDisplayPart[] => {
  if (!useAnimalIcons) return [{ text: notation }];

  return notation.split(".").flatMap((action, index) => {
    const separator: MoveNotationDisplayPart[] =
      index === 0 ? [] : [{ text: "." }];
    const icon = animalByPrefix[action[0] ?? ""];
    return icon
      ? [...separator, { icon, text: action.slice(1) }]
      : [...separator, { text: action }];
  });
};
