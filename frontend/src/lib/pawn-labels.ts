import { DOG_PAWNS } from "./pawns";

export const defaultPawnDisplayLabel = (
  filename: string,
  pawnType: string,
): string => {
  const match = /\d+/.exec(filename);
  return match ? `${pawnType} ${match[0]}` : filename;
};

export const dogPawnDisplayLabel = (filename: string): string => {
  const index = DOG_PAWNS.indexOf(filename);
  return index === -1 ? filename : `Dog ${index + 1}`;
};
