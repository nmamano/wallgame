import { readFile, writeFile } from "node:fs/promises";
import { glob } from "glob";
import { parse, stringify } from "svgson";
import pathBounds from "svg-path-bounds";

const TARGET_SIZE = 100;
const PADDING_RATIO = 0.01; // 1% padding around art

type SvgNode = {
  name: string;
  type: string;
  value?: string;
  attributes: Record<string, string>;
  children: SvgNode[];
};

async function main() {
  // Adjusted path to match the actual directory structure
  const files = await glob("public/pawns/**/*.svg");

  for (const file of files) {
    console.log("Normalizing", file);
    const raw = await readFile(file, "utf8");
    const svg = (await parse(raw)) as SvgNode;

    // 1) Flatten and collect all shapes (paths, rects, etc.) AND style/defs
    // This prevents double-wrapping if the script is run multiple times
    const shapes: SvgNode[] = [];
    const stylesAndDefs: SvgNode[] = [];

    function collectNodes(node: SvgNode) {
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
        attributes: { transform },
        children: shapes,
      },
    ];

    // 4) Normalize root svg attrs
    svg.attributes.viewBox = `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`;
    delete svg.attributes.width;
    delete svg.attributes.height;

    const out = stringify(svg);
    await writeFile(file, out, "utf8");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
