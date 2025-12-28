// Dynamically discover home SVG files at build time
// This automatically detects which files exist - no manual maintenance needed
const homeModules = import.meta.glob("/public/pawns/home/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

// Extract just the filenames from the full paths
export const HOME_PAWNS = Object.keys(homeModules)
  .map((path) => path.split("/").pop()!)
  .filter((name): name is string => !!name)
  .sort((a, b) => {
    // Natural sort: home1, home2, ..., home10, home11, etc.
    const numA = parseInt(/\d+/.exec(a)?.[0] ?? "0");
    const numB = parseInt(/\d+/.exec(b)?.[0] ?? "0");
    return numA - numB;
  });
