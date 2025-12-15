// Dynamically discover cat SVG files at build time
// This automatically detects which files exist - no manual maintenance needed
const catModules = import.meta.glob("/pawns/cat/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

// Extract just the filenames from the full paths
export const CAT_PAWNS = Object.keys(catModules)
  .map((path) => path.split("/").pop()!)
  .filter((name): name is string => !!name)
  .sort((a, b) => {
    // Natural sort: cat1, cat2, ..., cat10, cat11, etc.
    const numA = parseInt(/\d+/.exec(a)?.[0] ?? "0");
    const numB = parseInt(/\d+/.exec(b)?.[0] ?? "0");
    return numA - numB;
  });
