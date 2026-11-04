import { useMemo, type ReactNode } from "react";
import type { Cell, PlayerId } from "../../../shared/domain/game-types";
import type { PlayerWalk } from "../../../shared/domain/walks";
import {
  introWalkPlan,
  introWalkSeconds,
  walkAlphaAt,
  walkDisc,
  walkDots,
  walkDrawnAt,
  WALK_BOARD_UNITS,
  WALK_DISC_RING,
  WALK_DOT_RADIUS,
  WALK_DOT_RIM_RADIUS,
  WALK_RIM_COLOR,
} from "../../../shared/domain/walk-animation";
import { useWalkIntro } from "@/hooks/use-walk-intro";

interface WalkLayerProps {
  /** Each player's shortest walk, the first mover's first. */
  walks: PlayerWalk[];
  /** The cells of every pawn the board shows. */
  pawnCells: Cell[];
  /** The board grid's size, in pixels. */
  width: number;
  height: number;
  /** One cell's size without its gap, in pixels. */
  cellWidth: number;
  cellHeight: number;
  /** A cell's centre in the grid, in pixels. */
  cellCenter: (row: number, col: number) => { x: number; y: number };
  /** A player's colour. */
  colorOf: (playerId: PlayerId) => string;
  /** Not shown now; the clock goes on, so they do not play again. */
  hidden: boolean;
}

/**
 * The opening walks, drawn and timed as in the videos (walk-animation.ts):
 * each draws from its hunter as dots in its player's colour on a dark rim,
 * shows its steps in a disc beside its target, then fades. With reduced
 * motion both show whole, with no draw and no fade.
 *
 * Its own component, so the animation's clock (a state change each frame)
 * renders only this layer, not the board.
 *
 * The layer stays on the start position once the walks have faded, empty:
 * the game videos find it there by data-walk-layer and hide it
 * (render-game-video.mjs SITE_WALK_DOTS), as they draw their own.
 */
export function WalkLayer({
  walks,
  pawnCells,
  width,
  height,
  cellWidth,
  cellHeight,
  cellCenter,
  colorOf,
  hidden,
}: WalkLayerProps) {
  // The clock starts when these walks first show.
  const walksKey = walks
    .map((w) => `${w.playerId}:${w.cells.map((c) => c.join(",")).join(" ")}`)
    .join("|");
  const plan = useMemo(
    () => introWalkPlan(walks.map((w) => ({ points: w.cells }))),
    // walksKey names the walks; the plan reads only their lengths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walksKey],
  );
  const { t, reduced } = useWalkIntro(walksKey, introWalkSeconds(plan));

  // Where the walks lie, as fractions of the board: the same each frame.
  const geometry = useMemo(() => {
    if (width === 0 || height === 0) return null;
    const at = (cell: Cell) => {
      const c = cellCenter(cell[0], cell[1]);
      return { x: c.x / width, y: c.y / height };
    };
    const onPawn = (c: Cell) =>
      pawnCells.some((p) => p[0] === c[0] && p[1] === c[1]);
    return {
      // A cell's size as a fraction of the board: the pitch across.
      cell: at([0, 1]).x - at([0, 0]).x,
      pawns: pawnCells.map((c) => ({
        ...at(c),
        w: cellWidth / width,
        h: cellHeight / height,
      })),
      lines: walks.map((walk) => ({
        points: walk.cells.map(at),
        holes: walk.cells.slice(1, -1).filter(onPawn).map(at),
      })),
    };
  }, [walks, pawnCells, width, height, cellWidth, cellHeight, cellCenter]);

  if (walks.length === 0 || !geometry) return null;
  const layer = (children: ReactNode) => (
    <svg
      data-walk-layer=""
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 6 }}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {children}
    </svg>
  );
  if (t === null || hidden) return layer(null);

  const unit = width / WALK_BOARD_UNITS;
  const px = (q: { x: number; y: number }) => ({
    x: q.x * width,
    y: q.y * height,
  });
  return layer(
    walks.map((walk, k) => {
      const drawn = reduced ? 1 : walkDrawnAt(plan[k], t);
      const alpha = reduced ? 1 : walkAlphaAt(plan[k], t);
      if (drawn <= 0 || alpha <= 0) return null;
      const line = { ...geometry.lines[k], drawn };
      const dots = walkDots(line, geometry.cell).map(px);
      const disc = walkDisc(line, geometry.cell, geometry.pawns);
      const hex = colorOf(walk.playerId);
      const discAt = disc ? px(disc.at) : null;
      const discRadius = disc ? disc.radius * unit : 0;
      return (
        <g key={walk.playerId} opacity={alpha}>
          {dots.map((d, i) => (
            <circle
              key={`rim-${i}`}
              cx={d.x}
              cy={d.y}
              r={WALK_DOT_RIM_RADIUS * unit}
              fill={WALK_RIM_COLOR}
            />
          ))}
          {dots.map((d, i) => (
            <circle
              key={`dot-${i}`}
              cx={d.x}
              cy={d.y}
              r={WALK_DOT_RADIUS * unit}
              fill={hex}
            />
          ))}
          {discAt && (
            <>
              <circle
                cx={discAt.x}
                cy={discAt.y}
                r={discRadius}
                fill={hex}
                stroke={WALK_RIM_COLOR}
                strokeWidth={WALK_DISC_RING * unit}
              />
              <text
                x={discAt.x}
                y={discAt.y}
                dy="0.35em"
                textAnchor="middle"
                fontWeight={900}
                fontSize={discRadius * 1.1}
                fill="#fff"
              >
                {walk.cells.length - 1}
              </text>
            </>
          )}
        </g>
      );
    }),
  );
}
