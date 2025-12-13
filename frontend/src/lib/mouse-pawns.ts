// Dynamically discover mouse SVG files at build time
// This automatically detects which files exist - no manual maintenance needed
const mouseModules = import.meta.glob("/public/pawns/mouse/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

// Extract just the filenames from the full paths
export const MOUSE_PAWNS = Object.keys(mouseModules)
  .map((path) => path.split("/").pop()!)
  .filter((name): name is string => !!name)
  .sort((a, b) => {
    // Natural sort: mouse1, mouse2, ..., mouse10, mouse11, etc.
    const numA = parseInt(/\d+/.exec(a)?.[0] ?? "0");
    const numB = parseInt(/\d+/.exec(b)?.[0] ?? "0");
    return numA - numB;
  });
