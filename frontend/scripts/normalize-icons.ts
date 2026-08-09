import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import { parse, stringify, type INode } from "svgson";
import pathBounds from "svg-path-bounds";

const TARGET_SIZE = 100;
const PADDING_RATIO = 0.01; // 1% padding around art

// Both anchors are derived from this module's own location, so neither the
// search nor the writes depend on the working directory.
//
// Two separate cwd traps live here, and fixing one hid the other. The file sat
// in the repo-root scripts/ tree until 2026-08-09 and could not run at all,
// because Bun resolves PACKAGES from the module's path and its three
// dependencies are installed under frontend/. Moving it here fixed that - and
// left a worse bug behind: the glob was still the relative string
// "public/pawns/**/*.svg", so from the repository root the script matched
// nothing, wrote nothing, and exited 0. A run that reports success after
// touching no files is the failure this anchoring exists to prevent.
const FRONTEND_DIR = fileURLToPath(new URL("..", import.meta.url));
const PAWNS_DIR = fileURLToPath(new URL("../public/pawns", import.meta.url));

// --dry-run does everything except the write: it is how the discovery and
// parse path can be exercised without rewriting tracked assets.
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const files = await glob("**/*.svg", { cwd: PAWNS_DIR, absolute: true });

  // Silence here would mean the anchors are wrong, not that the work is done.
  if (files.length === 0) {
    console.error(
      `No SVGs found under ${PAWNS_DIR}. Refusing to report success.`,
    );
    process.exit(1);
  }
  console.log(
    `${DRY_RUN ? "Dry run: would normalize" : "Normalizing"} ${files.length} file(s) under ${PAWNS_DIR}`,
  );

  let written = 0;
  for (const file of files) {
    console.log("Normalizing", relative(FRONTEND_DIR, file));
    const raw = await readFile(file, "utf8");
    const svg = await parse(raw);

    // 1) Flatten and collect all shapes (paths, rects, etc.) AND style/defs
    // This prevents double-wrapping if the script is run multiple times
    const shapes: INode[] = [];
    const stylesAndDefs: INode[] = [];

    function collectNodes(node: INode) {
      if (node.name === "style" || node.name === "defs") {
        stylesAndDefs.push(node);
      } else if (
        [
          "path",
          "rect",
          "circle",
          "ellipse",
          "line",
          "polyline",
          "polygon",
        ].includes(node.name)
      ) {
        shapes.push(node);
      }

      // Recursively check children
      if (node.children) {
        node.children.forEach(collectNodes);
      }
    }

    collectNodes(svg);

    if (shapes.length === 0) {
      console.warn("  -> no shapes found, skipping");
      continue;
    }

    // 2) Collect all path bounds from the collected shapes
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const node of shapes) {
      if (node.attributes?.d) {
        try {
          const [x1, y1, x2, y2] = pathBounds(node.attributes.d);
          minX = Math.min(minX, x1);
          minY = Math.min(minY, y1);
          maxX = Math.max(maxX, x2);
          maxY = Math.max(maxY, y2);
        } catch {
          // malformed path, ignore
        }
      }
    }

    if (
      !isFinite(minX) ||
      !isFinite(minY) ||
      !isFinite(maxX) ||
      !isFinite(maxY)
    ) {
      console.warn("  -> no paths with valid bounds found, skipping");
      continue;
    }

    const width = maxX - minX;
    const height = maxY - minY;
    const artMax = Math.max(width, height);

    const innerSize = TARGET_SIZE * (1 - 2 * PADDING_RATIO); // e.g. 80 if padding=0.1
    const scale = innerSize / artMax;

    // After scaling, art width/height:
    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    // We want it centered in the 100×100 box
    const offsetX = (TARGET_SIZE - scaledWidth) / 2;
    const offsetY = (TARGET_SIZE - scaledHeight) / 2;

    // 3) Wrap collected shapes in a single <g transform="...">
    // Transform order:
    // 1. Translate(-minX, -minY) -> moves the top-left of the content to (0,0)
    // 2. Scale(scale) -> scales the content (now at 0,0) to the target size
    // 3. Translate(offsetX, offsetY) -> moves the scaled content to the center of the 100x100 box
    const transform = [
      `translate(${offsetX}, ${offsetY})`,
      `scale(${scale})`,
      `translate(${-minX}, ${-minY})`,
    ].join(" ");

    // Reconstruct SVG: styles/defs first, then the transformed group of shapes
    svg.children = [
      ...stylesAndDefs,
      {
        name: "g",
        type: "element",
        // Required by INode and never read for an element: svgson's stringify
        // consults node.value only on the `type === "text"` branch.
        value: "",
        attributes: { transform },
        children: shapes,
      },
    ];

    // 4) Normalize root svg attrs
    svg.attributes.viewBox = `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`;
    delete svg.attributes.width;
    delete svg.attributes.height;

    const out = stringify(svg);
    if (DRY_RUN) continue;
    await writeFile(file, out, "utf8");
    written++;
  }

  console.log(
    DRY_RUN
      ? `Dry run complete: ${files.length} file(s) discovered and parsed, 0 written.`
      : `Wrote ${written} file(s).`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
