import { assetUrl } from "@/lib/asset-url";

export type PawnStyleType = "dog" | "cat" | "mouse" | "elephant" | "home";

export const DEFAULT_PAWN_STYLES: Record<PawnStyleType, string> = {
  dog: "dog-puppy-03.svg",
  cat: "cat3.svg",
  mouse: "mouse20.svg",
  elephant: "elephant-14.svg",
  home: "home2.svg",
};

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

export const normalizePawnStyleSelection = (
  pawnStyle: string | undefined,
  type: PawnStyleType,
): string =>
  !pawnStyle || pawnStyle === "default" || isRetiredPawnStyle(pawnStyle, type)
    ? "default"
    : pawnStyle;

/** Board surfaces use undefined to ask the source resolver for the type default. */
export const normalizeBoardPawnStyle = (
  pawnStyle: string | undefined,
): string | undefined =>
  pawnStyle && pawnStyle !== "default" ? pawnStyle : undefined;

const ensureSvgExtension = (value: string): string => {
  if (value.includes(".")) {
    return value;
  }
  return `${value}.svg`;
};

const normalizePath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.includes("/")) {
    return `/${trimmed}`;
  }
  return trimmed;
};

export const resolvePawnStyleSrc = (
  pawnStyle: string | undefined,
  type: PawnStyleType,
): string => {
  const selection = normalizePawnStyleSelection(pawnStyle, type);
  const requestedStyle =
    selection === "default" ? DEFAULT_PAWN_STYLES[type] : selection;
  const normalized = normalizePath(requestedStyle);
  if (!normalized) {
    return assetUrl(`/pawns/${type}/${DEFAULT_PAWN_STYLES[type]}`);
  }

  // An off-site pawn is whatever the URL says; a site path still has to move
  // with the build's base.
  if (normalized.startsWith("http")) {
    return normalized;
  }
  if (normalized.startsWith("/")) {
    return assetUrl(normalized);
  }

  return assetUrl(`/pawns/${type}/${ensureSvgExtension(normalized)}`);
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
