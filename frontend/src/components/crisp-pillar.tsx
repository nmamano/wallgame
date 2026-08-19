/**
 * "Crisp" wall-intersection rendering.
 *
 * A pillar is the small square where two wall slots cross. Up to four walls
 * touch it, each with its own colour, and this draws the joint between them.
 *
 * Two independent questions, one rule each - no per-configuration branches:
 *
 *  - Which pixels are painted?  A lone wall ends in a half-disc, so its tip
 *    lands exactly on the centre of the intersection. Two walls meeting at a
 *    corner get a fillet on the far side. Everything else fills the square.
 *
 *  - What colour is each pixel?  The colour of the NEAREST wall, measured to
 *    the side of the square that wall enters from. Every wall that touches
 *    colours its own territory, whether it runs through or stops here.
 *    Straight-through joints get a flat seam, corners a 45 degree mitre,
 *    crossings an X, and a tee a WEDGE of the arriving wall's colour, apex at
 *    the centre of the pillar - the triangle (0,0)-(100,0)-(50,50) for a stem
 *    from the north.
 *
 *    The wedge and the X are the same rule seen twice. Nil chose this
 *    rendering when he picked the Crisp theme (2026-08-02), kept the X
 *    explicitly (2026-08-16, board task ab1b8358) and restored the wedge
 *    (2026-08-19: "we agreed on the wedge").
 *
 *    DO NOT DELETE THE WEDGE AGAIN. de9c5292 removed it behind a precedence
 *    rule - only walls with their opposite number present could colour - on
 *    the reading that a tee showed "a chevron notch of red poking down into
 *    the blue". That sentence was ours, not Nil's; his words were only that
 *    the junctions looked janky, and every other jank he named that week was
 *    sub-pixel. Board task c003ec83 holds the record.
 *
 * HOW IT IS COMPOSED, and the invariant that keeps seams out:
 *
 *   EVERY SHAPE IS A SUBSET OF THE SHAPE DRAWN BEFORE IT, AND THE FIRST SHAPE
 *   COVERS THE WHOLE PILLAR.
 *
 * So no edge ever meets the board background; each one blends a wall colour
 * into a wall colour. The pillar is a stack of nested layers, not a set of
 * tiles laid side by side.
 *
 * That is the difference between this and every earlier attempt. Abutting
 * shapes were the root cause, and a 1-unit stroke, a 12-unit stroke and a
 * widened clip were three ways of shoving abutting edges into each other so
 * that the gap between them closed. Two antialiased edges that meet cover their
 * shared pixel less than fully, and the board shows through the remainder - so
 * a tee's apex carried a hairline 11 percent darker than the wall even though
 * the regions on both sides of it were the SAME blue (measured 2026-08-19,
 * board task df2cf5b5; Nil: "i dont like the weird seams with different
 * color"). Nesting removes the gap instead of narrowing it.
 *
 * Everything is expressed in the SVG's own 0..100 viewBox, so it scales with
 * the element and holds at any board size or device pixel ratio.
 */
import { useId } from "react";
import type { EdgeColorKey } from "./styled-pillar";

export type PillarColors = Record<EdgeColorKey, string | null>;

interface Point {
  x: number;
  y: number;
}

const EDGES: EdgeColorKey[] = ["north", "east", "south", "west"];

const OPPOSITE: Record<EdgeColorKey, EdgeColorKey> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

/** Distance from a point to each side of the 0..100 box. */
const DISTANCE_TO_SIDE: Record<EdgeColorKey, (p: Point) => number> = {
  north: (p) => p.y,
  south: (p) => 100 - p.y,
  east: (p) => 100 - p.x,
  west: (p) => p.x,
};

const CORNER_POINT: Record<string, [number, number]> = {
  "north-west": [0, 0],
  "north-east": [100, 0],
  "south-east": [100, 100],
  "south-west": [0, 100],
};

/** The whole pillar square, as `shapePath` returns it for anything but an end or an elbow. */
const FULL_SQUARE = "M 0 0 L 100 0 L 100 100 L 0 100 Z";

/**
 * How far past its own box a SQUARE pillar's art is drawn, in viewBox units.
 *
 * 6 units is about 0.86 CSS px on a 14.4 px pillar, comfortably past the
 * 0.441 px by which a div background and SVG art are known to disagree on
 * identical geometry (measured 2026-08-05, recorded on board task c003ec83).
 *
 * The wall divs overlap this pillar by 0.984 CSS px on every side and sit UNDER
 * it (z-index 10 against 12, measured 2026-08-19), so art that stops at the box
 * edge lets a div of another colour show through. That was 2 pixels of pure
 * wall colour at desktop DPR 2.
 *
 * It moves no boundary. Every boundary inside the pillar is a half-plane in
 * absolute coordinates, so starting from a wider square extends each region
 * outward and shifts none of them - a tee's wedge still points at (50,50).
 *
 * Nothing escapes the pillar: the outermost SVG clips to its own bounds. That
 * is measured, not assumed - the probe reads zero spill at desktop and 393x650,
 * at DPR 1, 1.25, 1.75 and 2, with its injected control firing first.
 *
 * Only a square gets it. An end cap's arc and an elbow's fillet are real
 * silhouettes, and widening those would push the outline outward rather than
 * fill an overlap.
 */
const PILLAR_REACH = 6;

const OVERDRAWN_SQUARE = [
  `M ${-PILLAR_REACH} ${-PILLAR_REACH}`,
  `L ${100 + PILLAR_REACH} ${-PILLAR_REACH}`,
  `L ${100 + PILLAR_REACH} ${100 + PILLAR_REACH}`,
  `L ${-PILLAR_REACH} ${100 + PILLAR_REACH} Z`,
].join(" ");

const wallsTouching = (colors: PillarColors) => EDGES.filter((e) => colors[e]);

/** Which corner two walls meet at, e.g. north + east -> "north-east". */
const meetingCorner = (a: EdgeColorKey, b: EdgeColorKey) => {
  const northSouth = a === "north" || a === "south" ? a : b;
  const eastWest = a === "east" || a === "west" ? a : b;
  return `${northSouth}-${eastWest}`;
};

/** Outline of the painted region: end cap, elbow, or the full square. */
function shapePath(walls: EdgeColorKey[]): string {
  if (walls.length === 0) return "";

  if (walls.length === 1) {
    // Half-disc, so the wall reaches exactly the centre of the intersection.
    switch (walls[0]) {
      case "north":
        return "M 0 0 A 50 50 0 0 0 100 0 Z";
      case "south":
        return "M 100 100 A 50 50 0 0 0 0 100 Z";
      case "east":
        return "M 100 0 A 50 50 0 0 0 100 100 Z";
      case "west":
        return "M 0 100 A 50 50 0 0 0 0 0 Z";
    }
  }

  if (walls.length === 2 && OPPOSITE[walls[0]] !== walls[1]) {
    // Elbow: the square, with a fillet arc across the corner the walls turn
    // away from. The outer corner stays square, matching a real wall bend.
    const [cornerX, cornerY] = CORNER_POINT[meetingCorner(walls[0], walls[1])];
    const fromX = cornerX === 0 ? 0 : 100;
    const fromY = cornerY === 0 ? 100 : 0;
    const toX = cornerX === 0 ? 100 : 0;
    const toY = cornerY === 0 ? 0 : 100;
    const sweep = (cornerX === 0) !== (cornerY === 0) ? 1 : 0;
    return `M ${cornerX} ${cornerY} L ${fromX} ${fromY} A 100 100 0 0 ${sweep} ${toX} ${toY} Z`;
  }

  return FULL_SQUARE;
}

/** Sutherland-Hodgman clip of a convex polygon to the half-plane f(p) <= 0. */
function clipToHalfPlane(polygon: Point[], f: (p: Point) => number): Point[] {
  const clipped: Point[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const from = polygon[i];
    const to = polygon[(i + 1) % polygon.length];
    const fromSide = f(from);
    const toSide = f(to);
    if (fromSide <= 0) clipped.push(from);
    if ((fromSide < 0 && toSide > 0) || (fromSide > 0 && toSide < 0)) {
      const t = fromSide / (fromSide - toSide);
      clipped.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      });
    }
  }
  return clipped;
}

/** The part of the pillar closer to `wall` than to any other wall touching it. */
function territoryOf(wall: EdgeColorKey, walls: EdgeColorKey[]): Point[] {
  const near = -PILLAR_REACH;
  const far = 100 + PILLAR_REACH;
  let polygon: Point[] = [
    { x: near, y: near },
    { x: far, y: near },
    { x: far, y: far },
    { x: near, y: far },
  ];
  for (const other of walls) {
    if (other === wall) continue;
    polygon = clipToHalfPlane(
      polygon,
      (p) => DISTANCE_TO_SIDE[wall](p) - DISTANCE_TO_SIDE[other](p),
    );
  }
  return polygon;
}

/**
 * The pillar as a stack of NESTED shapes, largest first.
 *
 * Layer k covers the territories of its own wall AND of every wall after it, so
 * each layer is a strict subset of the one below. That nesting is the whole
 * design: an edge drawn inside an opaque shape blends one wall colour into
 * another, while two shapes that merely ABUT leave the board showing between two
 * antialiased edges. Every seam this file has ever had came from abutting -
 * including the hairline under a tee's apex, which sat between two regions of
 * the SAME blue and still read 11 percent dark.
 *
 * A layer repeating the colour below it would paint that colour over itself, so
 * it is dropped. That is what collapses a tee to two shapes: the run's two arms
 * become one flat base and the boundary between them stops existing.
 */
const paintLayers = (walls: EdgeColorKey[], colors: PillarColors) =>
  walls
    .map((wall, index) => ({ color: colors[wall]!, cover: walls.slice(index) }))
    .filter(
      (layer, index, all) =>
        index === 0 || layer.color !== all[index - 1].color,
    );

/** One path, one subpath per territory - a single shape with a single edge. */
const territoriesPath = (cover: EdgeColorKey[], walls: EdgeColorKey[]) =>
  cover
    .map(
      (wall) =>
        `M ${territoryOf(wall, walls)
          .map((p) => `${p.x} ${p.y}`)
          .join(" L ")} Z`,
    )
    .join(" ");

export function CrispPillar({ colors }: { colors: PillarColors }) {
  const rawId = useId();
  const clipId = `pillar-${rawId.replace(/:/g, "")}`;

  const walls = wallsTouching(colors);
  if (walls.length === 0) return null;

  const outline = shapePath(walls);
  const square = outline === FULL_SQUARE;
  const [base, ...covers] = paintLayers(walls, colors);

  // Keyed by DEPTH, not by colour. Colours repeat down the stack - a cross with
  // red and blue on alternating sides draws red, blue, red, blue - so a colour
  // key collides and React reconciles the wrong layers (Reviewer 3, 2026-08-19).
  const stack = covers.map((layer, depth) => (
    <path
      key={depth}
      d={territoriesPath(layer.cover, walls)}
      fill={layer.color}
    />
  ));

  // A square needs no clip: nothing leaves the widened square, and the SVG
  // bounds the rest. A silhouette does - and the BASE stays outside that clip,
  // because clipping a shape to its own outline antialiases that edge twice and
  // darkens it.
  const clipped = !square && covers.length > 0;
  return (
    <>
      {clipped && (
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <path d={outline} />
          </clipPath>
        </defs>
      )}
      <path d={square ? OVERDRAWN_SQUARE : outline} fill={base.color} />
      {clipped ? <g clipPath={`url(#${clipId})`}>{stack}</g> : stack}
    </>
  );
}
