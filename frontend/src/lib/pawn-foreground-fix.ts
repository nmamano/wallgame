export const resolvePawnForegroundFixSrc = (src: string): string | null => {
  if (/^https?:\/\//i.test(src)) return null;
  const match = /\/pawns\/cat\/(cat9|cat73)\.svg(?:[?#]|$)/i.exec(src);
  if (!match) return null;
  return src.replace(
    /\/pawns\/cat\/(cat9|cat73)\.svg(?:[?#].*)?$/i,
    "/pawn-foreground-fixes/cat/$1.png",
  );
};
