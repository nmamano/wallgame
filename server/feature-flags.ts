/**
 * Runtime feature flags, read from the environment.
 *
 * Deliberately its own module with no imports. The first version of
 * `globalRatingsEnabled` lived in `server/db/rating-write.ts`, which meant
 * asserting anything about it pulled in `server/db/index.ts` and therefore
 * required a `DATABASE_URL` - so the one behaviour that most needed a test (what
 * happens when the variable is ABSENT) was the one behaviour a test could not
 * reach. A flag is configuration, not a database concern.
 */

/**
 * Whether finished games also update the cross-variant global rating chain.
 *
 * Opt-IN, and that direction is the whole point: the cutover in
 * plans/combined-elo.md sec 5a needs the writer dormant while the backfill
 * rebuilds `global_ratings`, so an absent variable must mean off. An earlier
 * version used `!== "false"`, which enabled itself whenever the variable was
 * missing - the exact failure that only ever shows up in production, on the one
 * deploy where somebody forgot to set it.
 *
 * Changing this requires a service restart: `process.env` is read by a running
 * process, not pushed to one.
 */
export const globalRatingsEnabled = (): boolean =>
  process.env.GLOBAL_RATINGS_ENABLED === "true";
