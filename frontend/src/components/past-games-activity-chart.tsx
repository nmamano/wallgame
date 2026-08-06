import { useCallback, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PastGamesActivityDay } from "../../../shared/domain/past-games";
import { buildActivityAxis } from "@/lib/past-games";

/**
 * Columns rather than a line. With a filter applied most days are genuinely
 * empty, and a line drawn across them reads as continuous low activity - a
 * column chart shows absence as absence.
 */

const CHART_HEIGHT = 200;
const PADDING = { top: 8, right: 4, bottom: 22, left: 38 };
const MAX_BAR_WIDTH = 24;
const BAR_GAP = 2;
const BAR_RADIUS = 4;
const X_AXIS_LABEL_COUNT = 5;

/**
 * `date` is a UTC calendar day, so it is formatted in UTC too. Letting the
 * browser apply the local zone would shift every label a day west of Greenwich.
 */
const formatDay = (date: string, withYear = false): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });

/** Rounded at the data end, square at the baseline. */
const barPath = (x: number, y: number, width: number, height: number) => {
  const r = Math.min(BAR_RADIUS, width / 2, height);
  return `M ${x} ${y + height} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + width - r} ${y} Q ${x + width} ${y} ${x + width} ${y + r} L ${x + width} ${y + height} Z`;
};

interface PastGamesActivityChartProps {
  days: PastGamesActivityDay[];
  total: number;
  isPending: boolean;
  error: Error | null;
}

export function PastGamesActivityChart({
  days,
  total,
  isPending,
  error,
}: PastGamesActivityChartProps) {
  const [width, setWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  /**
   * Measured, not guessed: the chart fills whatever width the page gives it.
   *
   * A ref callback rather than an effect, because the plot area does not exist
   * on the first render - the loading state returns before it. An effect with
   * an empty dependency list would run once against a node that was not there
   * yet and never measure anything. React 19 runs the returned cleanup when the
   * node detaches, so this also covers the switch back to the list view.
   */
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;

    const updateWidth = () => setWidth(node.clientWidth);
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const plotWidth = Math.max(0, width - PADDING.left - PADDING.right);
    const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
    const slotWidth = days.length > 0 ? plotWidth / days.length : 0;
    const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, slotWidth - BAR_GAP));
    const peak = days.reduce((max, day) => Math.max(max, day.count), 0);
    const axis = buildActivityAxis(peak);
    return { plotWidth, plotHeight, slotWidth, barWidth, axis, peak };
  }, [days, width]);

  const labelIndices = useMemo(() => {
    if (days.length === 0) return [];
    const step = (days.length - 1) / (X_AXIS_LABEL_COUNT - 1);
    return Array.from({ length: X_AXIS_LABEL_COUNT }, (_, i) =>
      Math.round(i * step),
    );
  }, [days.length]);

  const activeDay = activeIndex === null ? null : (days[activeIndex] ?? null);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (days.length === 0) return;
    const current = activeIndex ?? days.length - 1;
    const moves: Record<string, number> = {
      ArrowLeft: current - 1,
      ArrowRight: current + 1,
      Home: 0,
      End: days.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActiveIndex(Math.min(days.length - 1, Math.max(0, next)));
  };

  if (isPending) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground"
        style={{ height: CHART_HEIGHT }}
      >
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading activity...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex items-center justify-center text-destructive"
        style={{ height: CHART_HEIGHT }}
      >
        {error.message}
      </div>
    );
  }

  const summary = `${total.toLocaleString()} ${total === 1 ? "game" : "games"} over the last ${days.length} days${
    geometry.peak > 0 ? `, peaking at ${geometry.peak} in a day` : ""
  }.`;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <div>
          <div className="text-2xl font-semibold text-foreground tabular-nums">
            {total.toLocaleString()}
          </div>
          <div className="text-sm text-muted-foreground">
            {total === 1 ? "game" : "games"} in the last {days.length} days
          </div>
        </div>
        {activeDay && (
          <div className="text-right text-sm">
            <div className="font-medium text-foreground tabular-nums">
              {activeDay.count} {activeDay.count === 1 ? "game" : "games"}
            </div>
            <div className="text-muted-foreground">
              {formatDay(activeDay.date, true)}
            </div>
          </div>
        )}
      </div>

      <div
        ref={measureRef}
        tabIndex={0}
        role="group"
        aria-label={`Games played per day. ${summary} Use the arrow keys to read individual days.`}
        onKeyDown={handleKeyDown}
        onBlur={() => setActiveIndex(null)}
        className="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {total === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground pointer-events-none">
            No games match your filters in this range.
          </div>
        )}

        {width > 0 && (
          <svg
            width={width}
            height={CHART_HEIGHT}
            role="img"
            aria-label={summary}
            className="overflow-visible"
          >
            {geometry.axis.ticks.map((tick) => {
              const y =
                PADDING.top +
                geometry.plotHeight * (1 - tick / geometry.axis.max);
              return (
                <g key={tick}>
                  <line
                    x1={PADDING.left}
                    y1={y}
                    x2={width - PADDING.right}
                    y2={y}
                    stroke="var(--border)"
                    strokeWidth={1}
                  />
                  <text
                    x={PADDING.left - 8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-muted-foreground text-[10px] tabular-nums"
                  >
                    {tick.toLocaleString()}
                  </text>
                </g>
              );
            })}

            {days.map((day, index) => {
              const slotX = PADDING.left + index * geometry.slotWidth;
              const isActive = index === activeIndex;
              const barHeight =
                (day.count / geometry.axis.max) * geometry.plotHeight;
              const barX = slotX + (geometry.slotWidth - geometry.barWidth) / 2;
              return (
                <g key={day.date}>
                  {isActive && (
                    <rect
                      x={slotX}
                      y={PADDING.top}
                      width={geometry.slotWidth}
                      height={geometry.plotHeight}
                      className="fill-muted-foreground/15"
                    />
                  )}
                  {day.count > 0 && (
                    <path
                      d={barPath(
                        barX,
                        PADDING.top + geometry.plotHeight - barHeight,
                        geometry.barWidth,
                        barHeight,
                      )}
                      fill="var(--chart-1)"
                    />
                  )}
                  {/* Full-height hit slot: the target is the day, not the
                      handful of pixels the bar happens to occupy. */}
                  <rect
                    x={slotX}
                    y={PADDING.top}
                    width={geometry.slotWidth}
                    height={geometry.plotHeight}
                    fill="transparent"
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseLeave={() =>
                      setActiveIndex((prev) => (prev === index ? null : prev))
                    }
                  />
                </g>
              );
            })}

            <line
              x1={PADDING.left}
              y1={PADDING.top + geometry.plotHeight}
              x2={width - PADDING.right}
              y2={PADDING.top + geometry.plotHeight}
              stroke="var(--border)"
              strokeWidth={1}
            />

            {labelIndices.map((index) => {
              const day = days[index];
              if (!day) return null;
              return (
                <text
                  key={day.date}
                  x={PADDING.left + (index + 0.5) * geometry.slotWidth}
                  y={CHART_HEIGHT - 6}
                  textAnchor={
                    index === 0
                      ? "start"
                      : index === days.length - 1
                        ? "end"
                        : "middle"
                  }
                  className="fill-muted-foreground text-[10px]"
                >
                  {formatDay(day.date)}
                </text>
              );
            })}
          </svg>
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {activeDay
          ? `${formatDay(activeDay.date, true)}: ${activeDay.count} games`
          : ""}
      </p>
    </div>
  );
}
