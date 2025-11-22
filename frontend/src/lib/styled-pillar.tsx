/**
 * Geometric Primitive Library for styling pillars
 */

import React from "react";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SquareOrientation = "W-E" | "N-S";
export type QuarterCircleOrientation = "W-S" | "N-W" | "E-N" | "S-E";
export type PillCapOrientation = "N" | "S" | "E" | "W";
export type EdgeColorKey = "north" | "east" | "south" | "west";

export interface LinearGradientSquareParams {
  boundingBox: BoundingBox;
  orientation: SquareOrientation;
  startColor: string;
  endColor: string;
}

export interface QuarterCircleParams {
  boundingBox: BoundingBox;
  orientation: QuarterCircleOrientation;
  startColor: string;
  endColor: string;
}

export interface PillCapParams {
  boundingBox: BoundingBox;
  orientation: PillCapOrientation;
  color: string;
}

export interface FourColorSquareParams {
  boundingBox: BoundingBox;
  colors: Record<EdgeColorKey, string>;
}

export type TwoColorSquareOrientation = "N" | "S" | "E" | "W";

export interface SideColorSquareParams {
  boundingBox: BoundingBox;
  orientation: TwoColorSquareOrientation;
  mainColor: string;
  sideColor: string;
}

export type CornerTwoColorSquareOrientation = "NE" | "NW" | "SE" | "SW";

export interface CornerColorSquareParams {
  boundingBox: BoundingBox;
  orientation: CornerTwoColorSquareOrientation;
  mainColor: string;
  sideColor: string;
}

export type ThreeSidedSquareMainOrientation = CornerTwoColorSquareOrientation;
export type ThreeSidedSquareSideOrientation = TwoColorSquareOrientation;

export interface ThreeSidedSquareParams {
  boundingBox: BoundingBox;
  mainOrientation: ThreeSidedSquareMainOrientation;
  sideOrientation: ThreeSidedSquareSideOrientation;
  mainColor: string;
  sideColor: string;
}

export interface ThreeColoredSidesSquareParams {
  boundingBox: BoundingBox;
  colors: Record<EdgeColorKey, string | null>;
}

export interface StyledPillarParams {
  boundingBox: BoundingBox;
  colors: Record<EdgeColorKey, string | null>;
}

class LinearGradientSquare {
  constructor(public params: LinearGradientSquareParams) {}

  /**
   * Returns the SVG gradient definition for this square
   */
  getGradientId(): string {
    const { boundingBox, orientation } = this.params;
    return `square-gradient-${boundingBox.x}-${boundingBox.y}-${orientation}`;
  }

  /**
   * Returns the SVG gradient element for this square
   */
  renderGradient(): React.ReactNode {
    const { orientation, startColor, endColor } = this.params;
    const gradientId = this.getGradientId();

    // W-E means horizontal gradient (x1=0, y1=0.5, x2=1, y2=0.5)
    // N-S means vertical gradient (x1=0.5, y1=0, x2=0.5, y2=1)
    const [x1, y1, x2, y2] =
      orientation === "W-E"
        ? ["0%", "50%", "100%", "50%"]
        : ["50%", "0%", "50%", "100%"];

    return (
      <linearGradient id={gradientId} x1={x1} y1={y1} x2={x2} y2={y2}>
        <stop offset="0%" stopColor={startColor} />
        <stop offset="100%" stopColor={endColor} />
      </linearGradient>
    );
  }

  /**
   * Renders the square as an SVG rect element
   */
  render(): React.ReactNode {
    const { boundingBox } = this.params;
    return (
      <rect
        x={boundingBox.x}
        y={boundingBox.y}
        width={boundingBox.width}
        height={boundingBox.height}
        fill={`url(#${this.getGradientId()})`}
      />
    );
  }
}

class QuarterCircle {
  constructor(public params: QuarterCircleParams) {}

  /**
   * Returns the SVG gradient definition for this quarter circle
   */
  getGradientId(): string {
    const { boundingBox, orientation } = this.params;
    return `qc-gradient-${boundingBox.x}-${boundingBox.y}-${orientation}`;
  }

  /**
   * Returns the path data for the quarter circle based on orientation
   */
  getPathData(): string {
    const { boundingBox, orientation } = this.params;
    const { x, y, width, height } = boundingBox;

    // Define the path based on orientation
    switch (orientation) {
      case "W-S":
        // Left edge + bottom edge + arc connecting them
        return `M ${x} ${y} L ${x} ${y + height} L ${x + width} ${
          y + height
        } A ${width} ${height} 0 0 0 ${x} ${y} Z`;
      case "N-W":
        // Top edge + left edge + arc connecting them
        return `M ${x} ${y} L ${
          x + width
        } ${y} A ${width} ${height} 0 0 1 ${x} ${y + height} L ${x} ${y} Z`;
      case "E-N":
        // Right edge + top edge + arc connecting them
        return `M ${x + width} ${y} L ${x + width} ${
          y + height
        } A ${width} ${height} 0 0 1 ${x} ${y} L ${x + width} ${y} Z`;
      case "S-E":
        // Bottom edge + right edge + arc connecting them
        return `M ${x} ${y + height} L ${x + width} ${y + height} L ${
          x + width
        } ${y} A ${width} ${height} 0 0 0 ${x} ${y + height} Z`;
    }
  }

  /**
   * Returns the center point and start angle for the conic gradient
   */
  getGradientParams(): { cx: string; cy: string; startAngle: number } {
    const { orientation } = this.params;

    // Position the gradient center and start angle based on orientation
    switch (orientation) {
      case "W-S":
        return { cx: "0%", cy: "100%", startAngle: 0 }; // Bottom-left corner
      case "N-W":
        return { cx: "0%", cy: "0%", startAngle: 90 }; // Top-left corner
      case "E-N":
        return { cx: "100%", cy: "0%", startAngle: 180 }; // Top-right corner
      case "S-E":
        return { cx: "100%", cy: "100%", startAngle: 270 }; // Bottom-right corner
    }
  }

  /**
   * Returns the SVG gradient element for this quarter circle
   */
  renderGradient(): React.ReactNode {
    const { startColor, endColor } = this.params;
    const gradientId = this.getGradientId();
    const { cx, cy } = this.getGradientParams();

    // Fallback radial gradient for browsers that don't support conic in SVG
    return (
      <radialGradient id={gradientId} cx={cx} cy={cy}>
        <stop offset="0%" stopColor={startColor} />
        <stop offset="100%" stopColor={endColor} />
      </radialGradient>
    );
  }

  /**
   * Render using foreignObject to support CSS conic gradients
   */
  renderWithConicGradient(): React.ReactNode {
    const { boundingBox } = this.params;
    const { cx, cy, startAngle } = this.getGradientParams();
    const pathData = this.getPathData();

    return (
      <g>
        <defs>
          <clipPath id={`clip-${this.getGradientId()}`}>
            <path d={pathData} />
          </clipPath>
        </defs>
        <foreignObject
          x={boundingBox.x}
          y={boundingBox.y}
          width={boundingBox.width}
          height={boundingBox.height}
          clipPath={`url(#clip-${this.getGradientId()})`}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              background: `conic-gradient(from ${startAngle}deg at ${cx} ${cy}, ${this.params.startColor} 0deg, ${this.params.endColor} 90deg)`,
            }}
          />
        </foreignObject>
      </g>
    );
  }
}

class PillCap {
  constructor(public params: PillCapParams) {}

  /**
   * Returns the SVG path data for the pill cap based on orientation.
   * The path includes a straight segment along the selected edge and
   * a cubic bezier curve that extends halfway into the bounding box.
   */
  getPathData(): string {
    const { boundingBox, orientation } = this.params;
    let { x, y, width, height } = boundingBox;
    width += 1;
    height += 1;
    x -= 0.5;
    y -= 0.5;

    switch (orientation) {
      case "N": {
        const depth = height / 2;
        return [
          `M ${x} ${y}`,
          `L ${x + width} ${y}`,
          `C ${x + width} ${y + depth} ${x} ${y + depth} ${x} ${y}`,
          "Z",
        ].join(" ");
      }
      case "S": {
        const depth = height / 2;
        const bottomY = y + height;
        return [
          `M ${x} ${bottomY}`,
          `L ${x + width} ${bottomY}`,
          `C ${x + width} ${bottomY - depth} ${x} ${
            bottomY - depth
          } ${x} ${bottomY}`,
          "Z",
        ].join(" ");
      }
      case "E": {
        const depth = width / 2;
        const rightX = x + width;
        return [
          `M ${rightX} ${y}`,
          `L ${rightX} ${y + height}`,
          `C ${rightX - depth} ${y + height} ${
            rightX - depth
          } ${y} ${rightX} ${y}`,
          "Z",
        ].join(" ");
      }
      case "W": {
        const depth = width / 2;
        return [
          `M ${x} ${y}`,
          `L ${x} ${y + height}`,
          `C ${x + depth} ${y + height} ${x + depth} ${y} ${x} ${y}`,
          "Z",
        ].join(" ");
      }
    }
  }

  /**
   * Render the pill cap as a filled path.
   */
  render(): React.ReactNode {
    return <path d={this.getPathData()} fill={this.params.color} />;
  }
}

interface Point { x: number; y: number }
type CornerKey = "top-left" | "top-right" | "bottom-right" | "bottom-left";

interface TriangleConfig {
  key: string;
  cornerKey: CornerKey;
  corner: Point;
  edgeMidpoint: Point;
  points: Point[];
  edge: EdgeColorKey;
  adjacent: EdgeColorKey;
  color: string;
  startColor: string;
  edgeAngle: number;
  diagonalAngle: number;
  cwEdgeToDiag: number;
  cwDiagToEdge: number;
}

const EDGE_TO_CORNERS: Record<EdgeColorKey, [CornerKey, CornerKey]> = {
  north: ["top-left", "top-right"],
  east: ["top-right", "bottom-right"],
  south: ["bottom-right", "bottom-left"],
  west: ["bottom-left", "top-left"],
};

const CORNER_TO_EDGES: Record<CornerKey, [EdgeColorKey, EdgeColorKey]> = {
  "top-left": ["north", "west"],
  "top-right": ["north", "east"],
  "bottom-right": ["east", "south"],
  "bottom-left": ["south", "west"],
};

const MAIN_ORIENTATION_TO_EDGES: Record<
  ThreeSidedSquareMainOrientation,
  [EdgeColorKey, EdgeColorKey]
> = {
  NE: ["north", "east"],
  NW: ["north", "west"],
  SE: ["south", "east"],
  SW: ["south", "west"],
};

const OPPOSITE_EDGE: Record<EdgeColorKey, EdgeColorKey> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

class FourColorSquare {
  constructor(public params: FourColorSquareParams) {}

  private getCenter(): Point {
    const { boundingBox } = this.params;
    return {
      x: boundingBox.x + boundingBox.width / 2,
      y: boundingBox.y + boundingBox.height / 2,
    };
  }

  private getEdgePoints() {
    const { x, y, width, height } = this.params.boundingBox;
    return {
      topLeft: { x, y },
      topRight: { x: x + width, y },
      bottomLeft: { x, y: y + height },
      bottomRight: { x: x + width, y: y + height },
      topMid: { x: x + width / 2, y },
      rightMid: { x: x + width, y: y + height / 2 },
      bottomMid: { x: x + width / 2, y: y + height },
      leftMid: { x, y: y + height / 2 },
    };
  }

  private getTriangles(): TriangleConfig[] {
    const { colors } = this.params;
    const center = this.getCenter();
    const points = this.getEdgePoints();

    const base = [
      {
        key: "north-west",
        cornerKey: "top-left" as CornerKey,
        corner: points.topLeft,
        edgeMidpoint: points.topMid,
        points: [points.topLeft, points.topMid, center],
        edge: "north" as EdgeColorKey,
        adjacent: "west" as EdgeColorKey,
      },
      {
        key: "north-east",
        cornerKey: "top-right" as CornerKey,
        corner: points.topRight,
        edgeMidpoint: points.topMid,
        points: [points.topRight, points.topMid, center],
        edge: "north" as EdgeColorKey,
        adjacent: "east" as EdgeColorKey,
      },
      {
        key: "east-north",
        cornerKey: "top-right" as CornerKey,
        corner: points.topRight,
        edgeMidpoint: points.rightMid,
        points: [points.topRight, points.rightMid, center],
        edge: "east" as EdgeColorKey,
        adjacent: "north" as EdgeColorKey,
      },
      {
        key: "east-south",
        cornerKey: "bottom-right" as CornerKey,
        corner: points.bottomRight,
        edgeMidpoint: points.rightMid,
        points: [points.bottomRight, points.rightMid, center],
        edge: "east" as EdgeColorKey,
        adjacent: "south" as EdgeColorKey,
      },
      {
        key: "south-east",
        cornerKey: "bottom-right" as CornerKey,
        corner: points.bottomRight,
        edgeMidpoint: points.bottomMid,
        points: [points.bottomRight, points.bottomMid, center],
        edge: "south" as EdgeColorKey,
        adjacent: "east" as EdgeColorKey,
      },
      {
        key: "south-west",
        cornerKey: "bottom-left" as CornerKey,
        corner: points.bottomLeft,
        edgeMidpoint: points.bottomMid,
        points: [points.bottomLeft, points.bottomMid, center],
        edge: "south" as EdgeColorKey,
        adjacent: "west" as EdgeColorKey,
      },
      {
        key: "west-south",
        cornerKey: "bottom-left" as CornerKey,
        corner: points.bottomLeft,
        edgeMidpoint: points.leftMid,
        points: [points.bottomLeft, points.leftMid, center],
        edge: "west" as EdgeColorKey,
        adjacent: "south" as EdgeColorKey,
      },
      {
        key: "west-north",
        cornerKey: "top-left" as CornerKey,
        corner: points.topLeft,
        edgeMidpoint: points.leftMid,
        points: [points.topLeft, points.leftMid, center],
        edge: "west" as EdgeColorKey,
        adjacent: "north" as EdgeColorKey,
      },
    ];

    return base.map((config) => {
      const edgeAngle = this.getAngle(config.corner, config.edgeMidpoint);
      const diagonalAngle = this.getAngle(config.corner, center);
      const cwEdgeToDiag = (diagonalAngle - edgeAngle + 360) % 360;
      const cwDiagToEdge = (edgeAngle - diagonalAngle + 360) % 360;

      return {
        ...config,
        edgeAngle,
        diagonalAngle,
        cwEdgeToDiag,
        cwDiagToEdge,
        color: colors[config.edge],
        startColor: averageHexColors(
          colors[config.edge],
          colors[config.adjacent]
        ),
      };
    });
  }

  private getAngle(from: Point, to: Point): number {
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    return angle + 360 + (90 % 360);
  }

  private getPivotPosition(corner: CornerKey): { x: string; y: string } {
    switch (corner) {
      case "top-left":
        return { x: "0%", y: "0%" };
      case "top-right":
        return { x: "100%", y: "0%" };
      case "bottom-right":
        return { x: "100%", y: "100%" };
      case "bottom-left":
        return { x: "0%", y: "100%" };
    }
  }

  private getClipPathId(key: string): string {
    const { boundingBox } = this.params;
    return `clip-four-color-${boundingBox.x}-${boundingBox.y}-${key}`;
  }

  private getCenterBlurRadius(): number {
    const { width, height } = this.params.boundingBox;
    const base = Math.min(width, height) * 0.08;
    return Math.max(4, Math.round(base));
  }

  private getAverageColor(): string {
    const { colors } = this.params;
    // Average all four edge colors
    const color1 = averageHexColors(colors.north, colors.east);
    const color2 = averageHexColors(colors.south, colors.west);
    return averageHexColors(color1, color2);
  }

  private getTriangleBackground(triangle: TriangleConfig): string {
    const pivot = this.getPivotPosition(triangle.cornerKey);

    let background: string;

    if (triangle.cwEdgeToDiag <= triangle.cwDiagToEdge) {
      const offset = triangle.cwEdgeToDiag || triangle.cwDiagToEdge;
      background = `conic-gradient(from ${triangle.edgeAngle}deg at ${pivot.x} ${pivot.y}, ${triangle.color} 0deg, ${triangle.startColor} ${offset}deg, ${triangle.startColor} 360deg)`;
    } else {
      const offset = triangle.cwDiagToEdge || triangle.cwEdgeToDiag;
      background = `conic-gradient(from ${triangle.diagonalAngle}deg at ${pivot.x} ${pivot.y}, ${triangle.startColor} 0deg, ${triangle.color} ${offset}deg, ${triangle.color} 360deg)`;
    }

    return background;
  }

  render(): React.ReactNode {
    const { boundingBox } = this.params;
    const triangles = this.getTriangles();
    const blurRadius = this.getCenterBlurRadius();
    const averageColor = this.getAverageColor();

    return (
      <g>
        {/* Base rectangle to eliminate gaps */}
        <rect
          x={boundingBox.x}
          y={boundingBox.y}
          width={boundingBox.width}
          height={boundingBox.height}
          fill={averageColor}
          stroke={averageColor}
          strokeWidth={1}
        />
        <defs>
          {triangles.map((triangle) => (
            <clipPath
              id={this.getClipPathId(triangle.key)}
              key={triangle.key}
              clipPathUnits="userSpaceOnUse"
            >
              <polygon
                points={triangle.points
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
              />
            </clipPath>
          ))}
        </defs>
        {triangles.map((triangle) => (
          <foreignObject
            key={triangle.key}
            x={boundingBox.x}
            y={boundingBox.y}
            width={boundingBox.width}
            height={boundingBox.height}
            clipPath={`url(#${this.getClipPathId(triangle.key)})`}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: averageColor,
                background: this.getTriangleBackground(triangle),
              }}
            />
          </foreignObject>
        ))}
        <foreignObject
          x={boundingBox.x}
          y={boundingBox.y}
          width={boundingBox.width}
          height={boundingBox.height}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              backdropFilter: `blur(${blurRadius}px)`,
              WebkitBackdropFilter: `blur(${blurRadius}px)`,
              maskImage:
                "radial-gradient(circle at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 35%, rgba(0,0,0,0) 70%)",
              WebkitMaskImage:
                "radial-gradient(circle at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 35%, rgba(0,0,0,0) 70%)",
              backgroundColor: "rgba(255,255,255,0)",
            }}
          />
        </foreignObject>
      </g>
    );
  }
}

class SideColorSquare {
  constructor(public params: SideColorSquareParams) {}

  private getCenter(): Point {
    const { boundingBox } = this.params;
    return {
      x: boundingBox.x + boundingBox.width / 2,
      y: boundingBox.y + boundingBox.height / 2,
    };
  }

  private getEdgePoints() {
    const { x, y, width, height } = this.params.boundingBox;
    return {
      topLeft: { x, y },
      topRight: { x: x + width, y },
      bottomLeft: { x, y: y + height },
      bottomRight: { x: x + width, y: y + height },
      topMid: { x: x + width / 2, y },
      rightMid: { x: x + width, y: y + height / 2 },
      bottomMid: { x: x + width / 2, y: y + height },
      leftMid: { x, y: y + height / 2 },
    };
  }

  private getTriangles(): TriangleConfig[] {
    const { orientation, mainColor, sideColor } = this.params;
    const center = this.getCenter();
    const points = this.getEdgePoints();

    const base = [
      {
        key: "north-west",
        cornerKey: "top-left" as CornerKey,
        corner: points.topLeft,
        edgeMidpoint: points.topMid,
        points: [points.topLeft, points.topMid, center],
        edge: "north" as EdgeColorKey,
        adjacent: "west" as EdgeColorKey,
      },
      {
        key: "north-east",
        cornerKey: "top-right" as CornerKey,
        corner: points.topRight,
        edgeMidpoint: points.topMid,
        points: [points.topRight, points.topMid, center],
        edge: "north" as EdgeColorKey,
        adjacent: "east" as EdgeColorKey,
      },
      {
        key: "east-north",
        cornerKey: "top-right" as CornerKey,
        corner: points.topRight,
        edgeMidpoint: points.rightMid,
        points: [points.topRight, points.rightMid, center],
        edge: "east" as EdgeColorKey,
        adjacent: "north" as EdgeColorKey,
      },
      {
        key: "east-south",
        cornerKey: "bottom-right" as CornerKey,
        corner: points.bottomRight,
        edgeMidpoint: points.rightMid,
        points: [points.bottomRight, points.rightMid, center],
        edge: "east" as EdgeColorKey,
        adjacent: "south" as EdgeColorKey,
      },
      {
        key: "south-east",
        cornerKey: "bottom-right" as CornerKey,
        corner: points.bottomRight,
        edgeMidpoint: points.bottomMid,
        points: [points.bottomRight, points.bottomMid, center],
        edge: "south" as EdgeColorKey,
        adjacent: "east" as EdgeColorKey,
      },
      {
        key: "south-west",
        cornerKey: "bottom-left" as CornerKey,
        corner: points.bottomLeft,
        edgeMidpoint: points.bottomMid,
        points: [points.bottomLeft, points.bottomMid, center],
        edge: "south" as EdgeColorKey,
        adjacent: "west" as EdgeColorKey,
      },
      {
        key: "west-south",
        cornerKey: "bottom-left" as CornerKey,
        corner: points.bottomLeft,
        edgeMidpoint: points.leftMid,
        points: [points.bottomLeft, points.leftMid, center],
        edge: "west" as EdgeColorKey,
        adjacent: "south" as EdgeColorKey,
      },
      {
        key: "west-north",
        cornerKey: "top-left" as CornerKey,
        corner: points.topLeft,
        edgeMidpoint: points.leftMid,
        points: [points.topLeft, points.leftMid, center],
        edge: "west" as EdgeColorKey,
        adjacent: "north" as EdgeColorKey,
      },
    ];

    // Map orientation to edge color key
    const sideEdge: EdgeColorKey =
      orientation === "N"
        ? "north"
        : orientation === "S"
          ? "south"
          : orientation === "E"
            ? "east"
            : "west";

    return base.map((config) => {
      const edgeAngle = this.getAngle(config.corner, config.edgeMidpoint);
      const diagonalAngle = this.getAngle(config.corner, center);
      const cwEdgeToDiag = (diagonalAngle - edgeAngle + 360) % 360;
      const cwDiagToEdge = (edgeAngle - diagonalAngle + 360) % 360;

      // Check if this triangle is adjacent to the side with sideColor
      const isAdjacentToSide = config.edge === sideEdge;

      return {
        ...config,
        edgeAngle,
        diagonalAngle,
        cwEdgeToDiag,
        cwDiagToEdge,
        color: isAdjacentToSide ? sideColor : mainColor,
        startColor: mainColor, // Always use mainColor for the diagonal
      };
    });
  }

  private getAngle(from: Point, to: Point): number {
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    return angle + 360 + (90 % 360);
  }

  private getPivotPosition(corner: CornerKey): { x: string; y: string } {
    switch (corner) {
      case "top-left":
        return { x: "0%", y: "0%" };
      case "top-right":
        return { x: "100%", y: "0%" };
      case "bottom-right":
        return { x: "100%", y: "100%" };
      case "bottom-left":
        return { x: "0%", y: "100%" };
    }
  }

  private getClipPathId(key: string): string {
    const { boundingBox } = this.params;
    return `clip-two-color-${boundingBox.x}-${boundingBox.y}-${key}`;
  }

  private getTriangleBackground(triangle: TriangleConfig): string {
    const pivot = this.getPivotPosition(triangle.cornerKey);
    const { orientation } = this.params;
    const sideEdge: EdgeColorKey =
      orientation === "N"
        ? "north"
        : orientation === "S"
          ? "south"
          : orientation === "E"
            ? "east"
            : "west";

    // If triangle is not adjacent to the side with sideColor, use solid mainColor
    if (triangle.edge !== sideEdge) {
      return triangle.color; // This will be mainColor
    }

    // For triangles adjacent to the side with sideColor, use conic gradient
    if (triangle.cwEdgeToDiag <= triangle.cwDiagToEdge) {
      const offset = triangle.cwEdgeToDiag || triangle.cwDiagToEdge;
      return `conic-gradient(from ${triangle.edgeAngle}deg at ${pivot.x} ${pivot.y}, ${triangle.color} 0deg, ${triangle.startColor} ${offset}deg, ${triangle.startColor} 360deg)`;
    } else {
      const offset = triangle.cwDiagToEdge || triangle.cwEdgeToDiag;
      return `conic-gradient(from ${triangle.diagonalAngle}deg at ${pivot.x} ${pivot.y}, ${triangle.startColor} 0deg, ${triangle.color} ${offset}deg, ${triangle.color} 360deg)`;
    }
  }

  render(): React.ReactNode {
    const { boundingBox, mainColor } = this.params;
    const triangles = this.getTriangles();

    return (
      <g>
        {/* Base rectangle to eliminate gaps */}
        <rect
          x={boundingBox.x}
          y={boundingBox.y}
          width={boundingBox.width}
          height={boundingBox.height}
          fill={mainColor}
          stroke={mainColor}
          strokeWidth={1}
        />
        <defs>
          {triangles.map((triangle) => (
            <clipPath
              id={this.getClipPathId(triangle.key)}
              key={triangle.key}
              clipPathUnits="userSpaceOnUse"
            >
              <polygon
                points={triangle.points
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
              />
            </clipPath>
          ))}
        </defs>
        {triangles.map((triangle) => (
          <foreignObject
            key={triangle.key}
            x={boundingBox.x}
            y={boundingBox.y}
            width={boundingBox.width}
            height={boundingBox.height}
            clipPath={`url(#${this.getClipPathId(triangle.key)})`}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: mainColor,
                background: this.getTriangleBackground(triangle),
              }}
            />
          </foreignObject>
        ))}
      </g>
    );
  }
}

interface CornerTriangleConfig {
  key: EdgeColorKey;
  points: Point[];
  pivotCornerKey: CornerKey;
  edgeColor: string;
  averageColor: string;
  edgeAngle: number;
  diagonalAngle: number;
  cwEdgeToDiag: number;
  cwDiagToEdge: number;
}

class CornerColorSquare {
  constructor(public params: CornerColorSquareParams) {}

  private getCenter(): Point {
    const { boundingBox } = this.params;
    return {
      x: boundingBox.x + boundingBox.width / 2,
      y: boundingBox.y + boundingBox.height / 2,
    };
  }

  private getCornerPoints(): Record<CornerKey, Point> {
    const { x, y, width, height } = this.params.boundingBox;
    return {
      "top-left": { x, y },
      "top-right": { x: x + width, y },
      "bottom-right": { x: x + width, y: y + height },
      "bottom-left": { x, y: y + height },
    };
  }

  private getMidpoint(edge: EdgeColorKey): Point {
    const { x, y, width, height } = this.params.boundingBox;
    switch (edge) {
      case "north":
        return { x: x + width / 2, y };
      case "east":
        return { x: x + width, y: y + height / 2 };
      case "south":
        return { x: x + width / 2, y: y + height };
      case "west":
        return { x, y: y + height / 2 };
    }
  }

  private getSideEdges(): EdgeColorKey[] {
    const { orientation } = this.params;
    switch (orientation) {
      case "NE":
        return ["north", "east"];
      case "NW":
        return ["north", "west"];
      case "SE":
        return ["south", "east"];
      case "SW":
        return ["south", "west"];
    }
  }

  private isSideEdge(edge: EdgeColorKey): boolean {
    return this.getSideEdges().includes(edge);
  }

  private getEdgeColor(edge: EdgeColorKey): string {
    return this.isSideEdge(edge)
      ? this.params.sideColor
      : this.params.mainColor;
  }

  private getAverageColor(): string {
    return averageHexColors(this.params.mainColor, this.params.sideColor);
  }

  private getPivotCorner(candidateCorners: CornerKey[]): CornerKey {
    const pivot = candidateCorners.find((corner) => {
      const [edgeA, edgeB] = CORNER_TO_EDGES[corner];
      return this.isSideEdge(edgeA) !== this.isSideEdge(edgeB);
    });

    return pivot ?? candidateCorners[0];
  }

  private extendPointOutward(
    point: Point,
    center: Point,
    distance: number
  ): Point {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) return point;
    const scale = (length + distance) / length;
    return {
      x: center.x + dx * scale,
      y: center.y + dy * scale,
    };
  }

  private getTriangles(): CornerTriangleConfig[] {
    const baseCenter = this.getCenter();
    const cornerPoints = this.getCornerPoints();
    const averageColor = this.getAverageColor();

    return (["north", "east", "south", "west"] as EdgeColorKey[]).map(
      (edge) => {
        const baseCornerKeys = EDGE_TO_CORNERS[edge];
        const pivotCornerKey = this.getPivotCorner(baseCornerKeys);
        const pivotPoint = cornerPoints[pivotCornerKey];
        const edgeMidpoint = this.getMidpoint(edge);

        // Extend center outward away from the edge by 1px
        const dx = baseCenter.x - edgeMidpoint.x;
        const dy = baseCenter.y - edgeMidpoint.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const extendedCenter =
          length === 0
            ? baseCenter
            : {
                x: baseCenter.x + (dx / length) * 1,
                y: baseCenter.y + (dy / length) * 1,
              };

        const edgeAngle = this.getAngle(pivotPoint, edgeMidpoint);
        const diagonalAngle = this.getAngle(pivotPoint, extendedCenter);
        const cwEdgeToDiag = (diagonalAngle - edgeAngle + 360) % 360;
        const cwDiagToEdge = (edgeAngle - diagonalAngle + 360) % 360;

        return {
          key: edge,
          points: [
            this.extendPointOutward(
              cornerPoints[baseCornerKeys[0]],
              extendedCenter,
              1
            ),
            this.extendPointOutward(
              cornerPoints[baseCornerKeys[1]],
              extendedCenter,
              1
            ),
            extendedCenter,
          ],
          pivotCornerKey,
          edgeColor: this.getEdgeColor(edge),
          averageColor,
          edgeAngle,
          diagonalAngle,
          cwEdgeToDiag,
          cwDiagToEdge,
        };
      }
    );
  }

  private getAngle(from: Point, to: Point): number {
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    return angle + 360 + (90 % 360);
  }

  private getPivotPosition(corner: CornerKey): { x: string; y: string } {
    switch (corner) {
      case "top-left":
        return { x: "0%", y: "0%" };
      case "top-right":
        return { x: "100%", y: "0%" };
      case "bottom-right":
        return { x: "100%", y: "100%" };
      case "bottom-left":
        return { x: "0%", y: "100%" };
    }
  }

  private getClipPathId(edge: EdgeColorKey): string {
    const { boundingBox } = this.params;
    return `clip-corner-two-color-${boundingBox.x}-${boundingBox.y}-${edge}`;
  }

  private getTriangleBackground(triangle: CornerTriangleConfig): string {
    const pivot = this.getPivotPosition(triangle.pivotCornerKey);

    if (triangle.cwEdgeToDiag <= triangle.cwDiagToEdge) {
      const offset = triangle.cwEdgeToDiag || triangle.cwDiagToEdge;

      // Smooth: edgeColor → averageColor
      return `conic-gradient(
        from ${triangle.edgeAngle}deg at ${pivot.x} ${pivot.y},
        ${triangle.edgeColor} 0deg,
        ${triangle.averageColor} ${offset}deg,
        ${triangle.averageColor} 360deg
      )`;
    }

    const offset = triangle.cwDiagToEdge || triangle.cwEdgeToDiag;

    // Smooth: averageColor → edgeColor
    return `conic-gradient(
      from ${triangle.diagonalAngle}deg at ${pivot.x} ${pivot.y},
      ${triangle.averageColor} 0deg,
      ${triangle.edgeColor} ${offset}deg,
      ${triangle.edgeColor} 360deg
    )`;
  }

  render(): React.ReactNode {
    const { boundingBox } = this.params;
    const triangles = this.getTriangles();
    const baseColor = this.params.mainColor;

    // Expand bounds to accommodate extended triangles (1px outward)
    const expandedBounds = {
      x: boundingBox.x - 1,
      y: boundingBox.y - 1,
      width: boundingBox.width + 2,
      height: boundingBox.height + 2,
    };

    return (
      <g>
        <rect
          x={boundingBox.x}
          y={boundingBox.y}
          width={boundingBox.width}
          height={boundingBox.height}
          fill={baseColor}
          stroke={baseColor}
          strokeWidth={1}
        />
        <defs>
          {triangles.map((triangle) => (
            <clipPath
              id={this.getClipPathId(triangle.key)}
              key={triangle.key}
              clipPathUnits="userSpaceOnUse"
            >
              <polygon
                points={triangle.points
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
              />
            </clipPath>
          ))}
        </defs>
        {triangles.map((triangle) => (
          <foreignObject
            key={triangle.key}
            x={expandedBounds.x}
            y={expandedBounds.y}
            width={expandedBounds.width}
            height={expandedBounds.height}
            clipPath={`url(#${this.getClipPathId(triangle.key)})`}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: baseColor,
                background: this.getTriangleBackground(triangle),
              }}
            />
          </foreignObject>
        ))}
      </g>
    );
  }
}

interface QuadrantInfo {
  key: CornerKey;
  rect: BoundingBox;
  edges: [EdgeColorKey, EdgeColorKey];
  outerCorner: Point;
}

interface TriangleGradientConfig {
  key: CornerKey;
  pivotCornerKey: CornerKey;
  pivotPoint: Point;
  edgeMidpoint: Point;
  center: Point;
  edgeAngle: number;
  diagonalAngle: number;
  cwEdgeToDiag: number;
  cwDiagToEdge: number;
}

class ThreeSidedSquare {
  constructor(public params: ThreeSidedSquareParams) {
    this.validateParams();
  }

  private validateParams() {
    const mainEdges = this.getMainEdges();
    const sideEdge = this.getSideEdge();

    if (mainEdges.includes(sideEdge)) {
      throw new Error(
        "ThreeSidedSquare: sideOrientation cannot overlap mainOrientation"
      );
    }
  }

  private getCenter(): Point {
    const { boundingBox } = this.params;
    return {
      x: boundingBox.x + boundingBox.width / 2,
      y: boundingBox.y + boundingBox.height / 2,
    };
  }

  private getMainEdges(): [EdgeColorKey, EdgeColorKey] {
    const { mainOrientation } = this.params;
    return MAIN_ORIENTATION_TO_EDGES[mainOrientation];
  }

  private getSideEdge(): EdgeColorKey {
    const { sideOrientation } = this.params;
    switch (sideOrientation) {
      case "N":
        return "north";
      case "S":
        return "south";
      case "E":
        return "east";
      case "W":
        return "west";
    }
  }

  private getQuadrants(): QuadrantInfo[] {
    const { boundingBox } = this.params;
    const { x, y, width, height } = boundingBox;
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    return [
      {
        key: "top-left" as CornerKey,
        rect: { x, y, width: halfWidth, height: halfHeight },
        edges: CORNER_TO_EDGES["top-left"],
        outerCorner: { x, y },
      },
      {
        key: "top-right" as CornerKey,
        rect: {
          x: x + halfWidth,
          y,
          width: halfWidth,
          height: halfHeight,
        },
        edges: CORNER_TO_EDGES["top-right"],
        outerCorner: { x: x + width, y },
      },
      {
        key: "bottom-right" as CornerKey,
        rect: {
          x: x + halfWidth,
          y: y + halfHeight,
          width: halfWidth,
          height: halfHeight,
        },
        edges: CORNER_TO_EDGES["bottom-right"],
        outerCorner: { x: x + width, y: y + height },
      },
      {
        key: "bottom-left" as CornerKey,
        rect: {
          x,
          y: y + halfHeight,
          width: halfWidth,
          height: halfHeight,
        },
        edges: CORNER_TO_EDGES["bottom-left"],
        outerCorner: { x, y: y + height },
      },
    ];
  }

  private getLinearGradientId(key: CornerKey): string {
    const { boundingBox } = this.params;
    return `three-sided-linear-${boundingBox.x}-${boundingBox.y}-${key}`;
  }

  private getTriangleClipId(key: CornerKey): string {
    const { boundingBox } = this.params;
    return `three-sided-triangle-${boundingBox.x}-${boundingBox.y}-${key}`;
  }

  private getAngle(from: Point, to: Point): number {
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    return angle + 360 + (90 % 360);
  }

  private getPivotPosition(corner: CornerKey): { x: string; y: string } {
    switch (corner) {
      case "top-left":
        return { x: "0%", y: "0%" };
      case "top-right":
        return { x: "100%", y: "0%" };
      case "bottom-right":
        return { x: "100%", y: "100%" };
      case "bottom-left":
        return { x: "0%", y: "100%" };
    }
  }

  private getRectCorners(rect: BoundingBox) {
    return {
      "top-left": { x: rect.x, y: rect.y },
      "top-right": { x: rect.x + rect.width, y: rect.y },
      "bottom-right": { x: rect.x + rect.width, y: rect.y + rect.height },
      "bottom-left": { x: rect.x, y: rect.y + rect.height },
    } as Record<CornerKey, Point>;
  }

  private getCornerOnEdge(
    rect: BoundingBox,
    edge: EdgeColorKey,
    exclude: Point
  ): Point {
    const corners = this.getRectCorners(rect);

    const candidates =
      edge === "north"
        ? [corners["top-left"], corners["top-right"]]
        : edge === "south"
          ? [corners["bottom-left"], corners["bottom-right"]]
          : edge === "east"
            ? [corners["top-right"], corners["bottom-right"]]
            : [corners["top-left"], corners["bottom-left"]];

    return (
      candidates.find(
        (corner) =>
          Math.abs(corner.x - exclude.x) > 0.0001 ||
          Math.abs(corner.y - exclude.y) > 0.0001
      ) ?? candidates[0]
    );
  }

  private getEdgeMidpoint(rect: BoundingBox, edge: EdgeColorKey): Point {
    switch (edge) {
      case "north":
        return { x: rect.x + rect.width / 2, y: rect.y };
      case "south":
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
      case "east":
        return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
      case "west":
        return { x: rect.x, y: rect.y + rect.height / 2 };
    }
  }

  private getLinearGradientLine(
    edge: EdgeColorKey,
    rect: BoundingBox
  ): { x1: number; y1: number; x2: number; y2: number } {
    const center = this.getCenter();

    switch (edge) {
      case "north":
        return {
          x1: rect.x + rect.width / 2,
          y1: center.y,
          x2: rect.x + rect.width / 2,
          y2: rect.y,
        };
      case "south":
        return {
          x1: rect.x + rect.width / 2,
          y1: center.y,
          x2: rect.x + rect.width / 2,
          y2: rect.y + rect.height,
        };
      case "east":
        return {
          x1: center.x,
          y1: rect.y + rect.height / 2,
          x2: rect.x + rect.width,
          y2: rect.y + rect.height / 2,
        };
      case "west":
        return {
          x1: center.x,
          y1: rect.y + rect.height / 2,
          x2: rect.x,
          y2: rect.y + rect.height / 2,
        };
    }
  }

  private getTriangleConfig(
    quadrant: QuadrantInfo,
    edge: EdgeColorKey,
    center: Point
  ): TriangleGradientConfig {
    const pivotPoint = quadrant.outerCorner;
    const edgeMidpoint = this.getEdgeMidpoint(quadrant.rect, edge);
    const edgeAngle = this.getAngle(pivotPoint, edgeMidpoint);
    const diagonalAngle = this.getAngle(pivotPoint, center);
    const cwEdgeToDiag = (diagonalAngle - edgeAngle + 360) % 360;
    const cwDiagToEdge = (edgeAngle - diagonalAngle + 360) % 360;

    return {
      key: quadrant.key,
      pivotCornerKey: quadrant.key,
      pivotPoint,
      edgeMidpoint,
      center,
      edgeAngle,
      diagonalAngle,
      cwEdgeToDiag,
      cwDiagToEdge,
    };
  }

  private getTriangleBackground(config: TriangleGradientConfig): string {
    const pivot = this.getPivotPosition(config.pivotCornerKey);

    if (config.cwEdgeToDiag <= config.cwDiagToEdge) {
      const offset = config.cwEdgeToDiag || config.cwDiagToEdge;
      return `conic-gradient(
        from ${config.edgeAngle}deg at ${pivot.x} ${pivot.y},
        ${this.params.sideColor} 0deg,
        ${this.params.mainColor} ${offset}deg,
        ${this.params.mainColor} 360deg
      )`;
    }

    const offset = config.cwDiagToEdge || config.cwEdgeToDiag;
    return `conic-gradient(
      from ${config.diagonalAngle}deg at ${pivot.x} ${pivot.y},
      ${this.params.mainColor} 0deg,
      ${this.params.sideColor} ${offset}deg,
      ${this.params.sideColor} 360deg
    )`;
  }

  private getCenterBlurRadius(): number {
    const { width, height } = this.params.boundingBox;
    const base = Math.min(width, height) * 0.08;
    return Math.max(4, Math.round(base));
  }

  render(): React.ReactNode {
    const quadrants = this.getQuadrants();
    const mainEdges = this.getMainEdges();
    const sideEdge = this.getSideEdge();
    const center = this.getCenter();

    const linearGradients: React.ReactNode[] = [];
    const clips: React.ReactNode[] = [];
    const elements: React.ReactNode[] = [];

    quadrants.forEach((quadrant) => {
      const touchesSide = quadrant.edges.includes(sideEdge);
      const mainEdgeCount = quadrant.edges.filter((edge) =>
        mainEdges.includes(edge)
      ).length;

      if (mainEdgeCount === 2 || (mainEdgeCount === 1 && !touchesSide)) {
        elements.push(
          <rect
            key={`three-sided-${quadrant.key}`}
            x={quadrant.rect.x}
            y={quadrant.rect.y}
            width={quadrant.rect.width}
            height={quadrant.rect.height}
            fill={this.params.mainColor}
          />
        );
        return;
      }

      if (mainEdgeCount === 0 && touchesSide) {
        const gradientId = this.getLinearGradientId(quadrant.key);
        const line = this.getLinearGradientLine(sideEdge, quadrant.rect);
        linearGradients.push(
          <linearGradient
            key={`gradient-${quadrant.key}`}
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
          >
            <stop offset="0%" stopColor={this.params.mainColor} />
            <stop offset="20%" stopColor={this.params.mainColor} />
            <stop offset="100%" stopColor={this.params.sideColor} />
          </linearGradient>
        );
        elements.push(
          <rect
            key={`three-sided-${quadrant.key}`}
            x={quadrant.rect.x}
            y={quadrant.rect.y}
            width={quadrant.rect.width}
            height={quadrant.rect.height}
            fill={`url(#${gradientId})`}
          />
        );
        return;
      }

      const mainEdge = mainEdges.find((edge) => quadrant.edges.includes(edge))!;
      const mainCorner = this.getCornerOnEdge(
        quadrant.rect,
        mainEdge,
        quadrant.outerCorner
      );
      const sideCorner = this.getCornerOnEdge(
        quadrant.rect,
        sideEdge,
        quadrant.outerCorner
      );

      const mainTrianglePoints = [quadrant.outerCorner, mainCorner, center]
        .map((point) => `${point.x},${point.y}`)
        .join(" ");

      const gradientTrianglePoints = [quadrant.outerCorner, center, sideCorner]
        .map((point) => `${point.x},${point.y}`)
        .join(" ");

      const clipId = this.getTriangleClipId(quadrant.key);
      clips.push(
        <clipPath
          id={clipId}
          key={`clip-${quadrant.key}`}
          clipPathUnits="userSpaceOnUse"
        >
          <polygon points={gradientTrianglePoints} />
        </clipPath>
      );

      const triangleConfig = this.getTriangleConfig(quadrant, sideEdge, center);

      elements.push(
        <g key={`three-sided-${quadrant.key}`}>
          <polygon points={mainTrianglePoints} fill={this.params.mainColor} />
          {/* Add a line along the shared edge to prevent white artifacts */}
          <line
            x1={quadrant.outerCorner.x}
            y1={quadrant.outerCorner.y}
            x2={center.x}
            y2={center.y}
            stroke={this.params.mainColor}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <foreignObject
            x={quadrant.rect.x}
            y={quadrant.rect.y}
            width={quadrant.rect.width}
            height={quadrant.rect.height}
            clipPath={`url(#${clipId})`}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: this.params.mainColor,
                background: this.getTriangleBackground(triangleConfig),
              }}
            />
          </foreignObject>
        </g>
      );
    });

    const blurRadius = this.getCenterBlurRadius();
    const { boundingBox } = this.params;

    return (
      <g>
        <defs>
          {linearGradients}
          {clips}
        </defs>
        {elements}
        <foreignObject
          x={boundingBox.x}
          y={boundingBox.y}
          width={boundingBox.width}
          height={boundingBox.height}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              backdropFilter: `blur(${blurRadius}px)`,
              WebkitBackdropFilter: `blur(${blurRadius}px)`,
              maskImage:
                "radial-gradient(circle at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 35%, rgba(0,0,0,0) 70%)",
              WebkitMaskImage:
                "radial-gradient(circle at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 35%, rgba(0,0,0,0) 70%)",
              backgroundColor: "rgba(255,255,255,0)",
            }}
          />
        </foreignObject>
      </g>
    );
  }
}

interface SplitTriangleConfig {
  key: string;
  pivotCornerKey: CornerKey;
  edge: EdgeColorKey;
  otherEdge: EdgeColorKey;
  edgeColor: string;
  averageColor: string;
  pivotPoint: Point;
  edgeMidpoint: Point;
  center: Point;
  edgeAngle: number;
  diagonalAngle: number;
  cwEdgeToDiag: number;
  cwDiagToEdge: number;
}

class ThreeColoredSidesSquare {
  constructor(public params: ThreeColoredSidesSquareParams) {
    this.validateColors();
  }

  private validateColors() {
    const values = Object.values(this.params.colors);
    const nullCount = values.filter((color) => color === null).length;
    if (nullCount !== 1) {
      throw new Error(
        "ThreeColoredSidesSquare: exactly one edge color must be null"
      );
    }
  }

  private getCenter(): Point {
    const { boundingBox } = this.params;
    return {
      x: boundingBox.x + boundingBox.width / 2,
      y: boundingBox.y + boundingBox.height / 2,
    };
  }

  private getNullEdge(): EdgeColorKey {
    const entry = Object.entries(this.params.colors).find(
      ([, color]) => color === null
    ) as [EdgeColorKey, string | null] | undefined;
    if (!entry) {
      throw new Error(
        "ThreeColoredSidesSquare: unable to determine null edge color"
      );
    }
    return entry[0];
  }

  private getRequiredEdgeColor(edge: EdgeColorKey): string {
    const color = this.params.colors[edge];
    if (!color) {
      throw new Error(
        `ThreeColoredSidesSquare: missing color for edge "${edge}"`
      );
    }
    return color;
  }

  private getQuadrants(): QuadrantInfo[] {
    const { boundingBox } = this.params;
    const { x, y, width, height } = boundingBox;
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    return [
      {
        key: "top-left",
        rect: { x, y, width: halfWidth, height: halfHeight },
        edges: CORNER_TO_EDGES["top-left"],
        outerCorner: { x, y },
      },
      {
        key: "top-right",
        rect: {
          x: x + halfWidth,
          y,
          width: halfWidth,
          height: halfHeight,
        },
        edges: CORNER_TO_EDGES["top-right"],
        outerCorner: { x: x + width, y },
      },
      {
        key: "bottom-right",
        rect: {
          x: x + halfWidth,
          y: y + halfHeight,
          width: halfWidth,
          height: halfHeight,
        },
        edges: CORNER_TO_EDGES["bottom-right"],
        outerCorner: { x: x + width, y: y + height },
      },
      {
        key: "bottom-left",
        rect: {
          x,
          y: y + halfHeight,
          width: halfWidth,
          height: halfHeight,
        },
        edges: CORNER_TO_EDGES["bottom-left"],
        outerCorner: { x, y: y + height },
      },
    ];
  }

  private getLinearGradientId(key: string): string {
    const { boundingBox } = this.params;
    return `three-colored-linear-${boundingBox.x}-${boundingBox.y}-${key}`;
  }

  private getTriangleClipId(key: string): string {
    const { boundingBox } = this.params;
    return `three-colored-triangle-${boundingBox.x}-${boundingBox.y}-${key}`;
  }

  private getEdgeMidpoint(rect: BoundingBox, edge: EdgeColorKey): Point {
    switch (edge) {
      case "north":
        return { x: rect.x + rect.width / 2, y: rect.y };
      case "south":
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
      case "east":
        return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
      case "west":
        return { x: rect.x, y: rect.y + rect.height / 2 };
    }
  }

  private getCornerOnEdge(
    rect: BoundingBox,
    edge: EdgeColorKey,
    exclude: Point
  ): Point {
    const corners = {
      "top-left": { x: rect.x, y: rect.y },
      "top-right": { x: rect.x + rect.width, y: rect.y },
      "bottom-right": {
        x: rect.x + rect.width,
        y: rect.y + rect.height,
      },
      "bottom-left": { x: rect.x, y: rect.y + rect.height },
    } as Record<CornerKey, Point>;

    const candidates =
      edge === "north"
        ? [corners["top-left"], corners["top-right"]]
        : edge === "south"
          ? [corners["bottom-left"], corners["bottom-right"]]
          : edge === "east"
            ? [corners["top-right"], corners["bottom-right"]]
            : [corners["top-left"], corners["bottom-left"]];

    return (
      candidates.find(
        (corner) =>
          Math.abs(corner.x - exclude.x) > 0.0001 ||
          Math.abs(corner.y - exclude.y) > 0.0001
      ) ?? candidates[0]
    );
  }

  private getLinearGradientLineTowardsCenter(
    edge: EdgeColorKey,
    rect: BoundingBox
  ): { x1: number; y1: number; x2: number; y2: number } {
    const edgeMidpoint = this.getEdgeMidpoint(rect, edge);

    switch (edge) {
      case "north":
        return {
          x1: edgeMidpoint.x,
          y1: rect.y,
          x2: edgeMidpoint.x,
          y2: rect.y + rect.height,
        };
      case "south":
        return {
          x1: edgeMidpoint.x,
          y1: rect.y + rect.height,
          x2: edgeMidpoint.x,
          y2: rect.y,
        };
      case "east":
        return {
          x1: rect.x + rect.width,
          y1: edgeMidpoint.y,
          x2: rect.x,
          y2: edgeMidpoint.y,
        };
      case "west":
        return {
          x1: rect.x,
          y1: edgeMidpoint.y,
          x2: rect.x + rect.width,
          y2: edgeMidpoint.y,
        };
    }
  }

  private getAngle(from: Point, to: Point): number {
    const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    return angle + 360 + (90 % 360);
  }

  private getPivotPosition(corner: CornerKey): { x: string; y: string } {
    switch (corner) {
      case "top-left":
        return { x: "0%", y: "0%" };
      case "top-right":
        return { x: "100%", y: "0%" };
      case "bottom-right":
        return { x: "100%", y: "100%" };
      case "bottom-left":
        return { x: "0%", y: "100%" };
    }
  }

  private getTriangleConfig(
    quadrant: QuadrantInfo,
    edge: EdgeColorKey,
    center: Point
  ): SplitTriangleConfig {
    const pivotPoint = quadrant.outerCorner;
    const edgeMidpoint = this.getEdgeMidpoint(quadrant.rect, edge);
    const otherEdge = quadrant.edges.find((candidate) => candidate !== edge)!;
    const edgeColor = this.getRequiredEdgeColor(edge);
    const otherColor = this.getRequiredEdgeColor(otherEdge);
    const averageColor = averageHexColors(edgeColor, otherColor);
    const edgeAngle = this.getAngle(pivotPoint, edgeMidpoint);
    const diagonalAngle = this.getAngle(pivotPoint, center);
    const cwEdgeToDiag = (diagonalAngle - edgeAngle + 360) % 360;
    const cwDiagToEdge = (edgeAngle - diagonalAngle + 360) % 360;

    return {
      key: `${quadrant.key}-${edge}`,
      pivotCornerKey: quadrant.key,
      edge,
      otherEdge,
      edgeColor,
      averageColor,
      pivotPoint,
      edgeMidpoint,
      center,
      edgeAngle,
      diagonalAngle,
      cwEdgeToDiag,
      cwDiagToEdge,
    };
  }

  private getTriangleBackground(triangle: SplitTriangleConfig): string {
    const pivot = this.getPivotPosition(triangle.pivotCornerKey);

    if (triangle.cwEdgeToDiag <= triangle.cwDiagToEdge) {
      const offset = triangle.cwEdgeToDiag || triangle.cwDiagToEdge;
      return `conic-gradient(
        from ${triangle.edgeAngle}deg at ${pivot.x} ${pivot.y},
        ${triangle.edgeColor} 0deg,
        ${triangle.averageColor} ${offset}deg,
        ${triangle.averageColor} 360deg
      )`;
    }

    const offset = triangle.cwDiagToEdge || triangle.cwEdgeToDiag;
    return `conic-gradient(
      from ${triangle.diagonalAngle}deg at ${pivot.x} ${pivot.y},
      ${triangle.averageColor} 0deg,
      ${triangle.edgeColor} ${offset}deg,
      ${triangle.edgeColor} 360deg
    )`;
  }

  private getTrianglePoints(
    quadrant: QuadrantInfo,
    edge: EdgeColorKey,
    center: Point
  ): string {
    const corner = this.getCornerOnEdge(
      quadrant.rect,
      edge,
      quadrant.outerCorner
    );
    const points =
      edge === quadrant.edges[0]
        ? [quadrant.outerCorner, corner, center]
        : [quadrant.outerCorner, center, corner];

    return points.map((point) => `${point.x},${point.y}`).join(" ");
  }

  private getCenterBlurRadius(): number {
    const { width, height } = this.params.boundingBox;
    const base = Math.min(width, height) * 0.1;
    return Math.max(4, Math.round(base));
  }

  private getAverageColor(): string {
    const { colors } = this.params;
    const nonNullColors = Object.values(colors).filter(
      (color): color is string => color !== null
    );
    if (nonNullColors.length === 0) {
      return "#808080"; // fallback gray
    }
    if (nonNullColors.length === 1) {
      return nonNullColors[0];
    }
    // Average all non-null colors
    let result = nonNullColors[0];
    for (let i = 1; i < nonNullColors.length; i++) {
      result = averageHexColors(result, nonNullColors[i]);
    }
    return result;
  }

  render(): React.ReactNode {
    const quadrants = this.getQuadrants();
    const nullEdge = this.getNullEdge();
    const center = this.getCenter();

    const gradientDefs: React.ReactNode[] = [];
    const clipDefs: React.ReactNode[] = [];
    const elements: React.ReactNode[] = [];

    quadrants.forEach((quadrant) => {
      const touchesNull = quadrant.edges.includes(nullEdge);

      if (touchesNull) {
        const nonNullEdge = quadrant.edges.find(
          (edge) => edge !== nullEdge
        )!;
        const edgeColor = this.getRequiredEdgeColor(nonNullEdge);
        const oppositeColor = this.getRequiredEdgeColor(
          OPPOSITE_EDGE[nonNullEdge]
        );
        const blendColor = averageHexColors(edgeColor, oppositeColor);
        const gradientId = this.getLinearGradientId(
          `${quadrant.key}-${nonNullEdge}`
        );
        const line = this.getLinearGradientLineTowardsCenter(
          nonNullEdge,
          quadrant.rect
        );

        gradientDefs.push(
          <linearGradient
            key={`three-colored-gradient-${quadrant.key}`}
            id={gradientId}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor={edgeColor} />
            <stop offset="100%" stopColor={blendColor} />
          </linearGradient>
        );

        elements.push(
          <rect
            key={`three-colored-${quadrant.key}`}
            x={quadrant.rect.x}
            y={quadrant.rect.y}
            width={quadrant.rect.width}
            height={quadrant.rect.height}
            fill={`url(#${gradientId})`}
          />
        );
        return;
      }

      quadrant.edges.forEach((edge) => {
        const triangleKey = `${quadrant.key}-${edge}`;
        const clipId = this.getTriangleClipId(triangleKey);
        const trianglePoints = this.getTrianglePoints(quadrant, edge, center);
        const triangleConfig = this.getTriangleConfig(quadrant, edge, center);

        clipDefs.push(
          <clipPath
            key={`three-colored-clip-${triangleKey}`}
            id={clipId}
            clipPathUnits="userSpaceOnUse"
          >
            <polygon points={trianglePoints} />
          </clipPath>
        );

        elements.push(
          <foreignObject
            key={`three-colored-fo-${triangleKey}`}
            x={quadrant.rect.x}
            y={quadrant.rect.y}
            width={quadrant.rect.width}
            height={quadrant.rect.height}
            clipPath={`url(#${clipId})`}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                background: this.getTriangleBackground(triangleConfig),
              }}
            />
          </foreignObject>
        );
      });
    });

    const blurRadius = this.getCenterBlurRadius();
    const averageColor = this.getAverageColor();

    return (
      <g>
        {/* Base rectangle to eliminate gaps */}
        <rect
          x={this.params.boundingBox.x}
          y={this.params.boundingBox.y}
          width={this.params.boundingBox.width}
          height={this.params.boundingBox.height}
          fill={averageColor}
          stroke={averageColor}
          strokeWidth={1}
        />
        <defs>
          {gradientDefs}
          {clipDefs}
        </defs>
        {elements}
        {/* Colored edge lines for smooth transitions */}
        {this.params.colors.north && (
          <line
            x1={this.params.boundingBox.x}
            y1={this.params.boundingBox.y}
            x2={this.params.boundingBox.x + this.params.boundingBox.width}
            y2={this.params.boundingBox.y}
            stroke={this.params.colors.north}
            strokeWidth={1}
          />
        )}
        {this.params.colors.south && (
          <line
            x1={this.params.boundingBox.x}
            y1={this.params.boundingBox.y + this.params.boundingBox.height}
            x2={this.params.boundingBox.x + this.params.boundingBox.width}
            y2={this.params.boundingBox.y + this.params.boundingBox.height}
            stroke={this.params.colors.south}
            strokeWidth={1}
          />
        )}
        {this.params.colors.east && (
          <line
            x1={this.params.boundingBox.x + this.params.boundingBox.width}
            y1={this.params.boundingBox.y}
            x2={this.params.boundingBox.x + this.params.boundingBox.width}
            y2={this.params.boundingBox.y + this.params.boundingBox.height}
            stroke={this.params.colors.east}
            strokeWidth={1}
          />
        )}
        {this.params.colors.west && (
          <line
            x1={this.params.boundingBox.x}
            y1={this.params.boundingBox.y}
            x2={this.params.boundingBox.x}
            y2={this.params.boundingBox.y + this.params.boundingBox.height}
            stroke={this.params.colors.west}
            strokeWidth={1}
          />
        )}
        <foreignObject
          x={this.params.boundingBox.x}
          y={this.params.boundingBox.y}
          width={this.params.boundingBox.width}
          height={this.params.boundingBox.height}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              backdropFilter: `blur(${blurRadius}px)`,
              WebkitBackdropFilter: `blur(${blurRadius}px)`,
              maskImage:
                "radial-gradient(circle at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 35%, rgba(0,0,0,0) 70%)",
              WebkitMaskImage:
                "radial-gradient(circle at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 35%, rgba(0,0,0,0) 70%)",
              backgroundColor: "rgba(255,255,255,0)",
            }}
          />
        </foreignObject>
      </g>
    );
  }
}

export class StyledPillar {
  constructor(public params: StyledPillarParams) {}

  private getNonNullColors(): { edge: EdgeColorKey; color: string }[] {
    return (
      Object.entries(this.params.colors) as [EdgeColorKey, string | null][]
    )
      .filter(([, color]) => color !== null)
      .map(([edge, color]) => ({ edge, color: color! }));
  }

  private areOpposite(edge1: EdgeColorKey, edge2: EdgeColorKey): boolean {
    return (
      (edge1 === "north" && edge2 === "south") ||
      (edge1 === "south" && edge2 === "north") ||
      (edge1 === "east" && edge2 === "west") ||
      (edge1 === "west" && edge2 === "east")
    );
  }

  private areAdjacent(edge1: EdgeColorKey, edge2: EdgeColorKey): boolean {
    return !this.areOpposite(edge1, edge2);
  }

  private getUniqueColors(): string[] {
    const nonNull = this.getNonNullColors();
    const colors = new Set(nonNull.map((c) => c.color));
    return Array.from(colors);
  }

  private getEdgesWithColor(color: string): EdgeColorKey[] {
    return this.getNonNullColors()
      .filter((c) => c.color === color)
      .map((c) => c.edge);
  }

  private areSameColorEdgesAdjacent(color: string): boolean {
    const edges = this.getEdgesWithColor(color);
    if (edges.length !== 2) return false;
    return this.areAdjacent(edges[0], edges[1]);
  }

  render(): React.ReactNode {
    const nonNull = this.getNonNullColors();
    const nonNullCount = nonNull.length;

    // Edge case: All colors are null
    if (nonNullCount === 0) {
      return <g />;
    }

    // Case: Only 1 non-null color -> PillCap
    if (nonNullCount === 1) {
      const { edge, color } = nonNull[0];
      const orientation: PillCapOrientation =
        edge === "north"
          ? "N"
          : edge === "south"
            ? "S"
            : edge === "east"
              ? "E"
              : "W";
      const pillCap = new PillCap({
        boundingBox: this.params.boundingBox,
        orientation,
        color,
      });
      return pillCap.render();
    }

    // Case: Only 2 non-null colors
    if (nonNullCount === 2) {
      const [first, second] = nonNull;

      // Opposite sides -> LinearGradientSquare
      if (this.areOpposite(first.edge, second.edge)) {
        const isNS = first.edge === "north" || first.edge === "south";
        const orientation: SquareOrientation = isNS ? "N-S" : "W-E";

        // Ensure correct direction: North->South or West->East
        const startColor = isNS
          ? this.params.colors.north!
          : this.params.colors.west!;
        const endColor = isNS
          ? this.params.colors.south!
          : this.params.colors.east!;

        const linearGradient = new LinearGradientSquare({
          boundingBox: this.params.boundingBox,
          orientation,
          startColor,
          endColor,
        });
        return (
          <g>
            <defs>{linearGradient.renderGradient()}</defs>
            {linearGradient.render()}
          </g>
        );
      }

      // Adjacent sides -> QuarterCircle
      const orientation: QuarterCircleOrientation =
        (first.edge === "west" && second.edge === "south") ||
        (first.edge === "south" && second.edge === "west")
          ? "W-S"
          : (first.edge === "north" && second.edge === "west") ||
              (first.edge === "west" && second.edge === "north")
            ? "N-W"
            : (first.edge === "east" && second.edge === "north") ||
                (first.edge === "north" && second.edge === "east")
              ? "E-N"
              : "S-E"; // (south + east) or (east + south)

      // Determine start/end colors based on orientation sweep direction
      // W-S: Sweep West -> South
      // N-W: Sweep North -> West
      // E-N: Sweep East -> North
      // S-E: Sweep South -> East
      let startColor: string;
      let endColor: string;

      switch (orientation) {
        case "W-S":
          startColor = this.params.colors.west!;
          endColor = this.params.colors.south!;
          break;
        case "N-W":
          startColor = this.params.colors.north!;
          endColor = this.params.colors.west!;
          break;
        case "E-N":
          startColor = this.params.colors.east!;
          endColor = this.params.colors.north!;
          break;
        case "S-E":
          startColor = this.params.colors.south!;
          endColor = this.params.colors.east!;
          break;
      }

      const quarterCircle = new QuarterCircle({
        boundingBox: this.params.boundingBox,
        orientation,
        startColor: startColor!,
        endColor: endColor!,
      });
      return quarterCircle.renderWithConicGradient();
    }

    // Case: 3 non-null colors
    if (nonNullCount === 3) {
      const uniqueColors = this.getUniqueColors();

      // All different -> ThreeColoredSidesSquare
      if (uniqueColors.length === 3) {
        const threeColored = new ThreeColoredSidesSquare({
          boundingBox: this.params.boundingBox,
          colors: this.params.colors,
        });
        return threeColored.render();
      }

      // All same -> Solid square of that color
      if (uniqueColors.length === 1) {
        const color = uniqueColors[0];
        return (
          <rect
            x={this.params.boundingBox.x}
            y={this.params.boundingBox.y}
            width={this.params.boundingBox.width}
            height={this.params.boundingBox.height}
            fill={color}
          />
        );
      }

      // Two colors (one appears twice)
      if (uniqueColors.length === 2) {
        // Find which color appears twice
        const colorCounts = new Map<string, number>();
        nonNull.forEach(({ color }) => {
          colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
        });
        const mainColor = Array.from(colorCounts.entries()).find(
          ([, count]) => count === 2
        )?.[0];
        const sideColor = Array.from(colorCounts.entries()).find(
          ([, count]) => count === 1
        )?.[0];

        if (mainColor && sideColor) {
          // Find the two edges with mainColor
          const mainEdges = this.getEdgesWithColor(mainColor);
          const sideEdge = this.getEdgesWithColor(sideColor)[0];

          // Check if main edges are adjacent or opposite
          if (
            mainEdges.length === 2 &&
            this.areAdjacent(mainEdges[0], mainEdges[1])
          ) {
            // Two adjacent match -> ThreeSidedSquare
            const mainOrientation: CornerTwoColorSquareOrientation =
              mainEdges.includes("north") && mainEdges.includes("east")
                ? "NE"
                : mainEdges.includes("north") && mainEdges.includes("west")
                  ? "NW"
                  : mainEdges.includes("south") && mainEdges.includes("east")
                    ? "SE"
                    : "SW";

            const sideOrientation: TwoColorSquareOrientation =
              sideEdge === "north"
                ? "N"
                : sideEdge === "south"
                  ? "S"
                  : sideEdge === "east"
                    ? "E"
                    : "W";

            const threeSided = new ThreeSidedSquare({
              boundingBox: this.params.boundingBox,
              mainOrientation,
              sideOrientation,
              mainColor,
              sideColor,
            });
            return threeSided.render();
          } else if (
            mainEdges.length === 2 &&
            this.areOpposite(mainEdges[0], mainEdges[1])
          ) {
            // Two opposite match -> SideColorSquare
            const orientation: TwoColorSquareOrientation =
              sideEdge === "north"
                ? "N"
                : sideEdge === "south"
                  ? "S"
                  : sideEdge === "east"
                    ? "E"
                    : "W";

            const sideColorSquare = new SideColorSquare({
              boundingBox: this.params.boundingBox,
              orientation,
              mainColor,
              sideColor,
            });
            return sideColorSquare.render();
          }
        }
      }
    }

    // Case: 4 non-null colors
    if (nonNullCount === 4) {
      const uniqueColors = this.getUniqueColors();

      // All same except 1 -> SideColorSquare
      if (uniqueColors.length === 2) {
        const colorCounts = new Map<string, number>();
        nonNull.forEach(({ color }) => {
          colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
        });
        const counts = Array.from(colorCounts.values()).sort();
        if (counts[0] === 1 && counts[1] === 3) {
          const mainColor = Array.from(colorCounts.entries()).find(
            ([, count]) => count === 3
          )?.[0];
          const sideColor = Array.from(colorCounts.entries()).find(
            ([, count]) => count === 1
          )?.[0];

          if (mainColor && sideColor) {
            const sideEdge = this.getEdgesWithColor(sideColor)[0];
            const orientation: TwoColorSquareOrientation =
              sideEdge === "north"
                ? "N"
                : sideEdge === "south"
                  ? "S"
                  : sideEdge === "east"
                    ? "E"
                    : "W";

            const sideColorSquare = new SideColorSquare({
              boundingBox: this.params.boundingBox,
              orientation,
              mainColor,
              sideColor,
            });
            return sideColorSquare.render();
          }
        }

        // 2 colors, same-colored sides adjacent -> CornerColorSquare
        if (counts[0] === 2 && counts[1] === 2) {
          const [color1, color2] = uniqueColors;
          if (
            this.areSameColorEdgesAdjacent(color1) &&
            this.areSameColorEdgesAdjacent(color2)
          ) {
            // Determine orientation based on which corners have which color
            const color1Edges = this.getEdgesWithColor(color1);
            const color2Edges = this.getEdgesWithColor(color2);

            // Find the corner where color1 edges meet
            let orientation: CornerTwoColorSquareOrientation = "NE";
            if (
              (color1Edges.includes("north") && color1Edges.includes("east")) ||
              (color2Edges.includes("north") && color2Edges.includes("east"))
            ) {
              // Check if color1 is at NE corner
              if (
                color1Edges.includes("north") &&
                color1Edges.includes("east")
              ) {
                orientation = "NE";
              } else {
                orientation = "SW";
              }
            } else if (
              (color1Edges.includes("north") && color1Edges.includes("west")) ||
              (color2Edges.includes("north") && color2Edges.includes("west"))
            ) {
              if (
                color1Edges.includes("north") &&
                color1Edges.includes("west")
              ) {
                orientation = "NW";
              } else {
                orientation = "SE";
              }
            } else if (
              (color1Edges.includes("south") && color1Edges.includes("east")) ||
              (color2Edges.includes("south") && color2Edges.includes("east"))
            ) {
              if (
                color1Edges.includes("south") &&
                color1Edges.includes("east")
              ) {
                orientation = "SE";
              } else {
                orientation = "NW";
              }
            } else {
              if (
                color1Edges.includes("south") &&
                color1Edges.includes("west")
              ) {
                orientation = "SW";
              } else {
                orientation = "NE";
              }
            }

            // Determine which color is mainColor (the one at the orientation corner)
            const orientationEdges = MAIN_ORIENTATION_TO_EDGES[orientation];
            const mainColor = orientationEdges.every((edge) =>
              color1Edges.includes(edge)
            )
              ? color1
              : color2;
            const sideColor = mainColor === color1 ? color2 : color1;

            const cornerColorSquare = new CornerColorSquare({
              boundingBox: this.params.boundingBox,
              orientation,
              mainColor: sideColor, // Swapped based on user feedback
              sideColor: mainColor, // Swapped based on user feedback
            });
            return cornerColorSquare.render();
          }
        }
      }

      // Fallback: FourColorSquare
      const fourColorSquare = new FourColorSquare({
        boundingBox: this.params.boundingBox,
        colors: {
          north: this.params.colors.north ?? "#000000",
          east: this.params.colors.east ?? "#000000",
          south: this.params.colors.south ?? "#000000",
          west: this.params.colors.west ?? "#000000",
        },
      });
      return fourColorSquare.render();
    }

    // Fallback (shouldn't reach here, but just in case)
    return <g />;
  }
}

function averageHexColors(colorA: string, colorB: string): string {
  const parse = (color: string) => {
    const hex = color.replace("#", "");
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16),
    };
  };

  const a = parse(colorA);
  const b = parse(colorB);
  const avg = (valueA: number, valueB: number) =>
    Math.round((valueA + valueB) / 2);

  const toHex = (value: number) => value.toString(16).padStart(2, "0");

  return `#${toHex(avg(a.r, b.r))}${toHex(avg(a.g, b.g))}${toHex(
    avg(a.b, b.b)
  )}`;
}
