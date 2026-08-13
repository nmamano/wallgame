const MARKER = 'data-pawn-backing-fill="white"';

export const restoreBackingFillMarkers = (
  svg: string,
  filename: string,
): string => {
  const restored = svg.replace(
    /fill="none" data-pawn-backing-fill="white"/g,
    'fill="rgb(255, 255, 255)"',
  );
  const remainingMarkers = restored.match(new RegExp(MARKER, "g"))?.length ?? 0;
  if (remainingMarkers > 0) {
    throw new Error(
      `${filename}: ${remainingMarkers} backing-fill marker(s) were not restored`,
    );
  }
  return restored;
};
