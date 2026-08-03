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
 *  - What colour is each pixel?  The colour of the wall it is closest to.
 *    Straight-through joints get a flat seam, corners get a 45 degree mitre,
 *    tees get a Y and crossings an X - all of it falls out of that one rule.
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

  return "M 0 0 L 100 0 L 100 100 L 0 100 Z";
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

  const outline = shapePath(walls);
  const distinctColors = new Set(walls.map((e) => colors[e]!));

  // One colour means no seams to draw.
  if (distinctColors.size === 1) {
    return <path d={outline} fill={walls.map((e) => colors[e]!)[0]} />;
  }

  return (
    <g>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <path d={outline} />
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
