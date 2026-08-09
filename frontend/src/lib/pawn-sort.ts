/**
 * Orders pawn art filenames the way a player reads them: cat1, cat2, ..., cat10,
 * cat11 - not the lexicographic cat1, cat10, cat11, cat2 that a directory listing
 * or a glob gives you.
 *
 * The name tie-break matters even though today's art has no two files sharing a
 * number: without it the result would depend on the order the caller happened to
 * read the directory in, and a filesystem makes no promise about that.
 */
export const sortPawnNames = (names: readonly string[]): string[] => {
  const leadingNumber = (name: string) =>
    parseInt(/\d+/.exec(name)?.[0] ?? "0");

  return [...names].sort((a, b) => {
    const diff = leadingNumber(a) - leadingNumber(b);
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
};
