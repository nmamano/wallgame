/** A clock as the timer cards print it; "—" when it was never recorded. */
export function formatClock(seconds: number | null): string {
  if (seconds === null) return "—";
  const whole = Math.max(0, Math.round(seconds));
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Whether a timer card flags low time. Only a ticking clock does: a replay or
 * a past position never pulses, as low time is an alarm for now.
 */
export const isLowOnTime = (args: {
  timeLeft: number | null;
  clockLive: boolean;
  isUnlimited: boolean;
}): boolean =>
  args.clockLive &&
  !args.isUnlimited &&
  args.timeLeft !== null &&
  args.timeLeft < 30;
