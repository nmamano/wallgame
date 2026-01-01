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

  if (normalized.startsWith("http") || normalized.startsWith("/")) {
    return normalized;
  }

  return `/pawns/${type}/${ensureSvgExtension(normalized)}`;
};
