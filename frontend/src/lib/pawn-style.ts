import { assetUrl } from "@/lib/asset-url";

export type PawnStyleType = "dog" | "cat" | "mouse" | "elephant" | "home";

export const DEFAULT_PAWN_STYLES: Record<PawnStyleType, string> = {
  dog: "pawns/animal-cycle/dog.svg",
  cat: "cat3.svg",
  mouse: "mouse20.svg",
  elephant: "pawns/animal-cycle/elephant.svg",
  home: "home2.svg",
};

export const RETIRED_PAWN_STYLES: Record<PawnStyleType, ReadonlySet<string>> = {
  dog: new Set(),
  cat: new Set(["cat126.svg", "cat150.svg", "cat188.svg", "cat237.svg"]),
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
