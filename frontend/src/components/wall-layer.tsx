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
 * Tailwind's shadow-md and the last-wall glow, as CSS filters rather than SVG
 * filter primitives: drop-shadow() resolves CSS custom properties, which
 * feDropShadow's flood-color does not do reliably across browsers.
 */
const WALL_SHADOW = "drop-shadow(0 2px 3px rgb(0 0 0 / 0.18))";
const WALL_GLOW = "drop-shadow(0 0 5px var(--wall-highlight-glow))";

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
        <g
          key={rect.key}
          style={{ filter: rect.glow ? WALL_GLOW : WALL_SHADOW }}
        >
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
