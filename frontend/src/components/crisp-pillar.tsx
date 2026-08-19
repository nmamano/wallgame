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

/**
 * How far past the pillar box a MULTI-colour pillar's art is computed and
 * clipped, in viewBox units.
 *
 * The same reach the single-colour branch buys with its stroke, by the same
 * argument: half a stroke lands outside the shape, so a stroke of 12 and a fill
 * that extends 6 cover the same ground. One number, one remedy, two branches.
 *
 * It exists because the wedge exposed the shortfall on the other branch. A tee
 * paints blue over a RED stem div near the pillar's left and right edges, where
 * the wedge is only about 0.1 px deep, and the blue fill stopped about 0.44 px
 * short of the box - so the div showed through as 2 pixels of pure #dc2626 at
 * desktop DPR 2 and a blend at 1.75 (measured 2026-08-19). Everywhere else the
 * div under an edge carries the SAME colour as the art over it, which is why
 * this went unseen until a tee put two colours in one pillar.
 *
 * The territory boundaries do not move. Each is a half-plane in absolute
 * coordinates, so a wider starting square extends every territory outward and
 * shifts none of them: the wedge's apex stays at (50,50).
 *
 * Nothing escapes the pillar. The outermost SVG clips to its own bounds, which
 * is measured rather than assumed - the single-colour branch has carried a
 * 12-unit stroke since 8cdadac2 and the probe reads zero spill at desktop and
 * 393x650, at DPR 1, 1.25, 1.75 and 2.
 *
 * Only a full square gets the wider clip. An elbow's fillet is a real
 * silhouette, so it keeps its own outline - the same line 8cdadac2 drew.
 */
const TERRITORY_REACH = PILLAR_OVERDRAW / 2;

const OVERDRAWN_SQUARE = [
  `M ${-TERRITORY_REACH} ${-TERRITORY_REACH}`,
  `L ${100 + TERRITORY_REACH} ${-TERRITORY_REACH}`,
  `L ${100 + TERRITORY_REACH} ${100 + TERRITORY_REACH}`,
  `L ${-TERRITORY_REACH} ${100 + TERRITORY_REACH} Z`,
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
  const near = -TERRITORY_REACH;
  const far = 100 + TERRITORY_REACH;
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

export function CrispPillar({ colors }: { colors: PillarColors }) {
  const rawId = useId();
  const clipId = `pillar-${rawId.replace(/:/g, "")}`;

  const walls = wallsTouching(colors);
  if (walls.length === 0) return null;

  const outline = shapePath(walls);
  const square = outline === FULL_SQUARE;
  const distinctColors = new Set(walls.map((e) => colors[e]!));

  // A full square reaches past its own box on BOTH branches, to cover the wall
  // divs that overlap it. Those divs reach about 1 CSS px into this pillar on
  // every side (measured 2026-08-16: the stem's box ends at 242.000 where the
  // pillar starts at 241.000), and a div background and SVG art do not
  // rasterise identically even on identical geometry. Unwidened, a wall's
  // overlap showed as a column of PURE wall colour down the pillar's edge -
  // pure, not a blend, so it was the art failing to reach rather than
  // antialiasing.

  // One colour means no internal seams to draw - one flat shape does it, and a
  // stroke of its own colour buys the reach.
  if (distinctColors.size === 1) {
    const only = colors[walls[0]]!;
    return (
      <path
        d={outline}
        fill={only}
        stroke={square ? only : undefined}
        strokeWidth={square ? PILLAR_OVERDRAW : undefined}
      />
    );
  }

  // More than one colour: each wall paints its own territory, and the clip is
  // what stops them. A square clip is widened with the territories so the reach
  // survives it; an elbow's fillet is a real silhouette and keeps its outline.
  return (
    <g>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <path d={square ? OVERDRAWN_SQUARE : outline} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {walls.map((wall) => (
          <polygon
            key={wall}
            points={territoryOf(wall, walls)
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
