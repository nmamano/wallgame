import { assetUrl } from "@/lib/asset-url";

export type PawnStyleType = "cat" | "mouse" | "home";

export const DEFAULT_PAWN_STYLES: Record<PawnStyleType, string> = {
  cat: "cat3.svg",
  mouse: "mouse20.svg",
  home: "home2.svg",
};

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
  const requestedStyle =
    !pawnStyle || pawnStyle === "default"
      ? DEFAULT_PAWN_STYLES[type]
      : pawnStyle;
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
  const match = /\/pawns\/(cat|mouse|home)\/([^/?]+)\.svg(?:[?#]|$)/i.exec(src);
  if (!match) return null;
  return src.replace(
    /\/pawns\/(cat|mouse|home)\/([^/?]+)\.svg(?:[?#].*)?$/i,
    "/pawn-backings/$1/$2.png",
  );
};
