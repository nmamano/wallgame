import { assetUrl } from "@/lib/asset-url";

export type PawnStyleType = "cat" | "mouse" | "home";

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
): string | null => {
  if (!pawnStyle) {
    return null;
  }

  const normalized = normalizePath(pawnStyle);
  if (!normalized) {
    return null;
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
