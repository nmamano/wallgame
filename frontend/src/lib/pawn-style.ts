import { assetUrl } from "@/lib/asset-url";
import {
  DEFAULT_PAWN_STYLES,
  builtInPawnPath,
  isBuiltInPawnStyle,
  type PawnStyleType,
} from "../../../shared/domain/pawn-styles";

export const RETIRED_PAWN_STYLES: Record<PawnStyleType, ReadonlySet<string>> = {
  dog: new Set(["dog-one-line-01.svg"]),
  cat: new Set([
    "cat17.svg",
    "cat31.svg",
    "cat47.svg",
    "cat52.svg",
    "cat54.svg",
    "cat94.svg",
    "cat105.svg",
    "cat126.svg",
    "cat150.svg",
    "cat168.svg",
    "cat174.svg",
    "cat179.svg",
    "cat188.svg",
    "cat219.svg",
    "cat237.svg",
    "cat244.svg",
    "cat245.svg",
  ]),
  mouse: new Set(["mouse26.svg", "mouse33.svg", "mouse68.svg", "mouse74.svg"]),
  elephant: new Set(),
  home: new Set(),
};

export const isRetiredPawnStyle = (
  pawnStyle: string,
  type: PawnStyleType,
): boolean => {
  const filename = pawnStyle
    .split(/[/?#]/)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase();
  return filename ? RETIRED_PAWN_STYLES[type].has(filename) : false;
};

/**
 * The skin to show: "default" for no skin, a retired one, or any value that
 * names no pawn file the site ships. Games stored before the server checked
 * skins (board task 6a245eee) can hold a URL; it is never loaded.
 */
export const normalizePawnStyleSelection = (
  pawnStyle: string | undefined,
  type: PawnStyleType,
): string => {
  const skin = pawnStyle?.trim();
  return !skin ||
    !isBuiltInPawnStyle(skin, type) ||
    isRetiredPawnStyle(skin, type)
    ? "default"
    : skin;
};

/** Board surfaces use undefined to ask the source resolver for the type default. */
export const normalizeBoardPawnStyle = (
  pawnStyle: string | undefined,
): string | undefined =>
  pawnStyle && pawnStyle !== "default" ? pawnStyle : undefined;

/** The URL of a pawn's art: its skin's file, or the type's default. */
export const resolvePawnStyleSrc = (
  pawnStyle: string | undefined,
  type: PawnStyleType,
): string => {
  const selection = normalizePawnStyleSelection(pawnStyle, type);
  const skin = selection === "default" ? DEFAULT_PAWN_STYLES[type] : selection;
  const path = builtInPawnPath(skin, type);
  return path
    ? assetUrl(path)
    : assetUrl(`/pawns/${type}/${DEFAULT_PAWN_STYLES[type]}`);
};

/**
 * The art the board paints for one pawn.
 *
 * The board and a player's avatar show the same piece, so they resolve it here
 * rather than each in their own way - two expressions could drift, and Nil's
 * rule of 2026-08-16 is that no such mechanism should exist. `visualType`
 * matters: a classic home is drawn as a house though its owner plays a cat.
 */
export const resolveBoardPawnSrc = (pawn: {
  type: PawnStyleType;
  visualType?: PawnStyleType;
  pawnStyle?: string;
}): string => resolvePawnStyleSrc(pawn.pawnStyle, pawn.visualType ?? pawn.type);

export const resolvePawnBackingSrc = (src: string): string | null => {
  if (/^https?:\/\//i.test(src)) return null;
  const match =
    /\/pawns\/(dog|cat|mouse|elephant|home)\/([^/?]+)\.svg(?:[?#]|$)/i.exec(
      src,
    );
  if (!match) return null;
  return src.replace(
    /\/pawns\/(dog|cat|mouse|elephant|home)\/([^/?]+)\.svg(?:[?#].*)?$/i,
    "/pawn-backings/$1/$2.png",
  );
};
