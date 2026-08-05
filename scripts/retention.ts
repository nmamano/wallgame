/**
 * Do players come back? Prints the answer.
 *
 *   bun scripts/retention.ts
 *
 * Reads DATABASE_URL and writes nothing. Against production, run it the way
 * every other read of that database is run - inside the machine, where the
 * connection string already exists - rather than pointing a local process at
 * it.
 *
 * What each number means, and what it does not, is documented once in
 * server/db/retention-queries.ts. Read that before quoting any of this. The
 * short version is printed as a heading here so a pasted screenshot carries
 * its own caveats.
 */
import { db } from "../server/db";
import {
  retentionReport,
  type RetentionCohort,
} from "../server/db/retention-queries";

const pct = (rate: number | null): string =>
  rate === null ? "    -" : `${(rate * 100).toFixed(0).padStart(4)}%`;

const row = (c: RetentionCohort): string =>
  [
    c.cohortDay,
    String(c.players).padStart(7),
    String(c.games).padStart(5),
    `${String(c.returnedNextDay).padStart(3)} ${pct(c.nextDayRate)}`,
    `${String(c.returnedWithin7d).padStart(3)} ${pct(c.within7dRate)}`,
  ].join("  ");

const report = await retentionReport(db, new Date());

console.log(
  [
    "",
    "RETENTION - returning browsers with counted, completed MATCH games.",
    "Puzzles excluded, local games never reach the server, and one person on",
    "two devices counts as two. A return is a game on a LATER UTC DAY, so a",
    "rematch sitting never counts as coming back.",
    `As of ${report.asOfUtcDay} (UTC).`,
    "",
    "cohort day    players  games  next day     within 7d",
  ].join("\n"),
);

if (report.cohorts.length === 0) {
  // Say what was found, not why. An empty report has several causes that look
  // identical from here - no games at all, only puzzle games, or games whose
  // seats carry no browser id - and the query cannot tell them apart.
  console.log(
    "  no eligible match players yet. Expected before anonymous browser ids\n" +
      "  have been deployed; also what an empty database, or one holding only\n" +
      "  puzzle games, looks like.",
  );
} else {
  report.cohorts.forEach((c) => console.log(row(c)));
}

const p = report.pooled;
console.log(
  [
    "",
    `pooled: ${p.players} players, ${p.games} games lifetime to date`,
    // Two rates, two denominators. A cohort is only in one of them once it has
    // had the chance to answer that question - a dash means "too soon to say",
    // never "nobody came back".
    `  next day:  ${p.returnedNextDay}/${p.d1EligiblePlayers} = ${pct(p.nextDayRate)}` +
      `   (cohorts at least 2 days old)`,
    `  within 7d: ${p.returnedWithin7d}/${p.within7dEligiblePlayers} = ${pct(p.within7dRate)}` +
      `   (cohorts at least 8 days old)`,
    "",
  ].join("\n"),
);

process.exit(0);
