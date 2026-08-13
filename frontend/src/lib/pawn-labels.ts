export const defaultPawnDisplayLabel = (
  filename: string,
  pawnType: string,
): string => {
  const match = /\d+/.exec(filename);
  return match ? `${pawnType} ${match[0]}` : filename;
};

export const dogPawnDisplayLabel = (filename: string): string => {
  const number = /\d+/.exec(filename)?.[0] ?? filename;
  if (filename.startsWith("dog-one-line-")) return `One Line ${number}`;
  if (filename.startsWith("dog-puppy-")) return `Puppy ${number}`;
  return filename;
};
