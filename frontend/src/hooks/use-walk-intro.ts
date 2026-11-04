import { useEffect, useState } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(REDUCED_MOTION).matches;

/**
 * The clock of the opening walks (shared/domain/walk-animation.ts): the
 * seconds since the walks keyed `walksKey` first showed, or null once
 * `totalSeconds` have gone by. A new key (other walks, or the same walks
 * after the board left the start position and came back) starts it again.
 * An empty key has no walks and no clock.
 *
 * With prefers-reduced-motion the clock does not run: `reduced` is true,
 * and the board shows the walks whole, with no draw and no fade, until
 * `totalSeconds` are over.
 */
export function useWalkIntro(
  walksKey: string,
  totalSeconds: number,
): { t: number | null; reduced: boolean } {
  const [t, setT] = useState<number | null>(null);
  const [reduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (walksKey === "" || totalSeconds <= 0) {
      setT(null);
      return;
    }
    setT(0);
    if (reduced) {
      const timer = window.setTimeout(() => setT(null), totalSeconds * 1000);
      return () => window.clearTimeout(timer);
    }
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const seconds = (now - startedAt) / 1000;
      if (seconds >= totalSeconds) {
        setT(null);
        return;
      }
      setT(seconds);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [walksKey, totalSeconds, reduced]);

  return { t, reduced };
}
