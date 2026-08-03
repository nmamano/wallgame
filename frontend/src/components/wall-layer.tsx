/**
 * Wall bodies, drawn as SVG instead of as positioned <div>s.
 *
 * WHY. A wall and the joint at its end sit edge to edge. While the wall was a
 * div, the compositor snapped its background to whole device pixels, but the
 * joint - an SVG path - antialiased that same edge at its true fractional
 * position. Two collinear edges, two rasterizers: at some device pixel ratios
 * the joint covers its boundary pixel only partially while the wall covers it
 * fully, and the background shows through as a hairline. The wall then reads as
 * a pixel wider than its own joint, which is exactly what players report.
 *
 * Measured before the change with seam-probe.mjs: background bleeding into a
 * wall run at DPR 1.5 and DPR 3, on BOTH board themes and with single-coloured
 * walls, which is what ruled out the joint artwork as the cause.
 *
 * Drawing walls with the same rasterizer, from the same coordinates, removes
 * the disagreement instead of papering over it with an overlap fudge whose
 * correct size would depend on the device pixel ratio.
 *
 * One layer is rendered per z-index so the board's painting order (staged under
 * placed, joints over everything) is preserved exactly.
 */

import type { ReactNode } from "react";

export interface JointPlacement {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The joint's artwork, drawn in its own local space. Crisp uses a 0..100
   * box; the default theme uses its bounding box. `localOrigin` and
   * `localSize` say which, so this layer can map either onto the real rect.
   */
  art: ReactNode;
  localOrigin: { x: number; y: number };
  localSize: number;
}

interface JointLayerProps {
  z: number;
  width: number;
  height: number;
  joints: JointPlacement[];
}

/**
 * Every wall joint in ONE grid-sized SVG, instead of one <svg> per
 * intersection inside its own positioned <div>.
 *
 * The div was the problem. A div's laid-out box is snapped to 1/64 of a pixel,
 * so a joint asked to be 14.4px wide is actually 14.390625px, while the wall
 * beside it - now SVG geometry - is exactly 14.4px. Those two disagree by four
 * hundredths of a pixel, which is invisible until the two edges happen to fall
 * on opposite sides of a device-pixel boundary, and then the joint renders a
 * whole device pixel off from its wall. That is the "walls and pillars are 1px
 * off" report, and it is why the seam appears at some zoom levels and not
 * others. Geometry inside an SVG is never layout-snapped, so putting both
 * sides in SVG makes the disagreement impossible rather than unlikely.
 */
export function JointLayer({ z, width, height, joints }: JointLayerProps) {
  if (joints.length === 0) return null;

  return (
    <svg
      className="absolute left-0 top-0 pointer-events-none"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ zIndex: z, overflow: "visible" }}
    >
      {joints.map((joint) => (
        <g
          key={joint.key}
          transform={
            `translate(${joint.x} ${joint.y}) ` +
            `scale(${joint.width / joint.localSize} ${joint.height / joint.localSize}) ` +
            `translate(${-joint.localOrigin.x} ${-joint.localOrigin.y})`
          }
        >
          {joint.art}
        </g>
      ))}
    </svg>
  );
}

export interface WallLayerRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  /** Calculated (engine-suggested) walls are drawn semi-transparent. */
  opacity: number;
  /** Staged and premoved walls carry a dashed outline. */
  dashed: boolean;
  /** The most recently placed wall glows. */
  glow: boolean;
}

interface WallLayerProps {
  /** Painting order, matching the z-index the wall divs used to carry. */
  z: number;
  width: number;
  height: number;
  rects: WallLayerRect[];
}

/**
 * One layer of a CSS box-shadow, expressed so it can be drawn as SVG.
 *
 * box-shadow semantics, which drop-shadow() cannot express: the shadow is the
 * element's box INFLATED BY `spread`, offset by (dx, dy), blurred with a
 * Gaussian whose standard deviation is half the blur radius, and painted
 * behind the element. CSS drop-shadow() has no spread parameter at all, so it
 * structurally cannot reproduce the last-wall glow's 3px spread - a tighter
 * blur radius is not the same effect, it is a smaller one.
 */
interface ShadowLayer {
  dx: number;
  dy: number;
  /** CSS blur RADIUS, converted to a std deviation on use. */
  blur: number;
  spread: number;
  color: string;
}

/** Tailwind `shadow-md`, which the wall divs carried as a class. */
const WALL_SHADOW: ShadowLayer[] = [
  { dx: 0, dy: 4, blur: 6, spread: -1, color: "rgb(0 0 0 / 0.1)" },
  { dx: 0, dy: 2, blur: 4, spread: -2, color: "rgb(0 0 0 / 0.1)" },
];

/**
 * The last-placed wall's glow. The div set this as an INLINE box-shadow, which
 * overrode the shadow-md class outright rather than adding to it - so a
 * glowing wall has this and only this.
 */
const WALL_GLOW: ShadowLayer[] = [
  { dx: 0, dy: 0, blur: 8, spread: 3, color: "var(--wall-highlight-glow)" },
];

function ShadowRects({
  rect,
  layers,
}: {
  rect: WallLayerRect;
  layers: ShadowLayer[];
}) {
  return (
    <>
      {layers.map((layer, index) => {
        const width = rect.width + 2 * layer.spread;
        const height = rect.height + 2 * layer.spread;
        // A negative spread can outgrow a thin wall; such a layer contributes
        // nothing and a negative width is invalid SVG.
        if (width <= 0 || height <= 0) return null;
        return (
          <rect
            key={index}
            x={rect.x - layer.spread + layer.dx}
            y={rect.y - layer.spread + layer.dy}
            width={width}
            height={height}
            style={{ fill: layer.color, filter: `blur(${layer.blur / 2}px)` }}
          />
        );
      })}
    </>
  );
}

export function WallLayer({ z, width, height, rects }: WallLayerProps) {
  if (rects.length === 0) return null;

  return (
    <svg
      className="absolute left-0 top-0 pointer-events-none"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ zIndex: z, overflow: "visible" }}
    >
      {rects.map((rect) => (
        <g key={rect.key}>
          {/* Behind the wall, and only the wall's own shadow: the glow REPLACES
              shadow-md rather than adding to it, matching the inline
              box-shadow that used to override the class. */}
          <ShadowRects
            rect={rect}
            layers={rect.glow ? WALL_GLOW : WALL_SHADOW}
          />
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            fill={rect.color}
            opacity={rect.opacity}
          />
          {rect.dashed && (
            // Inset by half the stroke so it sits inside the wall, the way a
            // CSS border does under border-box sizing.
            <rect
              x={rect.x + 1}
              y={rect.y + 1}
              width={Math.max(rect.width - 2, 0)}
              height={Math.max(rect.height - 2, 0)}
              fill="none"
              stroke="#4b5563"
              strokeWidth={2}
              strokeDasharray="4 3"
            />
          )}
        </g>
      ))}
    </svg>
  );
}
