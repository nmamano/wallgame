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
 *  - What colour is each pixel?  The colour of the nearest wall that RUNS
 *    THROUGH the pillar - one whose opposite number is also present, so it
 *    passes out the far side as one unbroken wall. A wall that merely stops
 *    here yields to those; only when nothing runs through (a lone wall, or a
 *    corner) does it colour anything. Straight-through joints get a flat seam,
 *    corners a 45 degree mitre, crossings an X, and a tee is simply the run,
 *    unbroken, with the stem butting into its face.
 *
 *    The precedence is the whole point. Nearest-wall alone gave the stem of a
 *    tee the triangle (0,0)-(100,0)-(50,50) - a wedge of its colour driven
 *    point-first into the middle of the run, which reads as a chevron notch
 *    rather than as two walls meeting (board task c003ec83; Nil, 2026-08-03).
 *    A wall that stops at another wall does not eat into it.
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
 * How far a FULL-SQUARE pillar's art is widened, in viewBox units, to cover the
 * wall divs that overlap it.
 *
 * Half a stroke lands outside the shape, so 12 buys 6 units of reach - about
 * 0.86 CSS px on a 14.4 px pillar, comfortably past the 0.441 px by which a
 * div background and SVG art are known to disagree on identical geometry
 * (measured 2026-08-05, recorded on this board).
 *
 * Bisected against a pixel probe on 2026-08-16, at desktop and 393x650, at DPR
 * 1, 1.25, 1.75 and 2.
 *
 * IT IS 12 RATHER THAN 8 BECAUSE THE FIRST PROBE WAS TOO BLUNT. That probe
 * only counted near-pure stem colour, and by that measure 8 read as clean
 * everywhere. A stricter one, counting any lift of the stem's channel above
 * the run colour, found a single BLENDED pixel below the butt face at DPR 2
 * and at DPR 1.75 - so the residue was never confined to fractional DPR; it
 * was confined to what the instrument could see.
 *
 * 12 reaches zero at all eight combinations, and 16 and 20 measure identically
 * to 12 - a plateau, not the first value that happened to pass. None of them
 * spilled any colour outside the pillar.
 *
 * What remains at fractional DPR is blending ON the butt face itself, where
 * two walls genuinely meet and the edge lands mid-device-pixel. No coordinate
 * or width change touches that; it is the same paint-time effect this board
 * already closed as a no-fix.
 *
 * Only the square gets it. On the end cap's arc or the elbow's fillet, widening
 * would push a visible silhouette outward rather than fill an overlap, and
 * those shapes are not what this fixes.
 */
const PILLAR_OVERDRAW = 12;

const wallsTouching = (colors: PillarColors) => EDGES.filter((e) => colors[e]);

/**
 * The walls that decide the colouring: those that run straight through, or all
 * of them when none does.
 *
 * A wall with its opposite number present is one continuous wall passing
 * across the pillar, so nothing that stops here may break it. With no such
 * wall - a lone end, or a corner - there is nothing to yield to and every
 * touching wall colours its own side as before.
 */
const colouringWalls = (walls: EdgeColorKey[]): EdgeColorKey[] => {
  const throughWalls = walls.filter((wall) => walls.includes(OPPOSITE[wall]));
  return throughWalls.length > 0 ? throughWalls : walls;
};

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
  let polygon: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
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

export function CrispPillar({ colors }: { colors: PillarColors }) {
  const rawId = useId();
  const clipId = `pillar-${rawId.replace(/:/g, "")}`;

  const walls = wallsTouching(colors);
  if (walls.length === 0) return null;

  // The painted REGION still comes from every wall that touches - a tee is a
  // full square whichever wall colours it - but only the walls that run
  // through decide what colour those pixels are.
  const outline = shapePath(walls);
  const painters = colouringWalls(walls);
  const distinctColors = new Set(painters.map((e) => colors[e]!));

  // One colour means no internal seams to draw. A tee reaches this line: the
  // run is one colour and the stem is not consulted.
  //
  // A full square is widened to cover the wall divs overlapping it. Those divs
  // reach about 1 CSS px into this pillar on every side (measured 2026-08-16:
  // the stem's box ends at 242.000 where the pillar starts at 241.000), and a
  // div background and SVG art do not rasterise identically even on identical
  // geometry. Unwidened, the stem's overlap showed as a column of PURE #dc2626
  // down the pillar's edge - pure, not a blend, so it was the art failing to
  // reach rather than antialiasing. It only became visible when the colouring
  // rule sent a tee down this branch: before, every territory matched the wall
  // beneath it, so the same shortfall had nothing to expose.
  if (distinctColors.size === 1) {
    const only = colors[painters[0]]!;
    const square = outline === FULL_SQUARE;
    return (
      <path
        d={outline}
        fill={only}
        stroke={square ? only : undefined}
        strokeWidth={square ? PILLAR_OVERDRAW : undefined}
      />
    );
  }

  return (
    <g>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <path d={outline} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {painters.map((wall) => (
          <polygon
            key={wall}
            points={territoryOf(wall, painters)
              .map((p) => `${p.x},${p.y}`)
              .join(" ")}
            fill={colors[wall]!}
            // Widen each territory by half a unit so neighbours overlap
            // instead of leaving an antialiased hairline between them.
            stroke={colors[wall]!}
            strokeWidth={1}
          />
        ))}
      </g>
    </g>
  );
}
