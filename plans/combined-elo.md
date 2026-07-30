# Combined ELO ranking across variants

Task `da87ebfb`. Design pass, written before code, for review by Project Reviewer 1.

Nil's framing on the board: _"Currently, there are too many rankings. The truth is
that the different variants mostly transfer, so they should have the same ELO
ranking. This new global elo should be the default. Maybe: also a global ELO
ranking across time controls. I don't see why not."_

---

## 0. A premise check, measured against production first

The task says the rankings are too sparse and blames fragmentation into
3 variants x 4 time controls = 12 buckets. Measured on prod (2026-07-30, via the
public API, no DB access needed):

| bucket              | ranked players |
| ------------------- | -------------- |
| standard/blitz      | 2              |
| standard/rapid      | 2              |
| freestyle/blitz     | 2              |
| the other 9 buckets | 0              |

Three distinct humans total: Nil, Amplob, Player_mxudahxtjj.

And the reason is not fragmentation:

```
rated games:    32
unrated games:  4206
total:          4238
```

The most common unrated matchups are `Guest vs Easy Bot` (45), `Guest vs
Transformer Bot` (18), `Guest vs Superhuman Bot` (10), `Nil vs Easy Bot` (12).
**99.2% of all games are unrated, because they are played by logged-out guests
against bots** - neither side is a rating-bearing entity.

So the honest expectation to set: combining the buckets turns _12 tables holding
0-2 players each_ into _1 table holding 3 players_. That is a real improvement
in the model and in how the page reads, but it does not populate the leaderboard.
The lever that would actually populate it is rating logged-in-human vs bot games
against fixed bot anchors - proposed as a follow-up in section 7, deliberately
NOT folded into this slice.

This does not change the recommendation. A single rating across variants is the
correct model, it is cheap, and it is a prerequisite for the bot-anchor work
(which would otherwise have to be built 12 times). It just should not be sold as
the fix for an empty page.

---

## 1. What exists today

- `ratings` table, PK `(user_id, variant, time_control)`, holding Glicko-2 state
  (`rating`, `rating_deviation`, `volatility`) plus precomputed `peak_rating`,
  `record_wins`, `record_losses`, `last_game_at`. `server/db/schema/ratings.ts`.
- `server/games/rating-system.ts` - a self-contained Glicko-2 implementation.
  `newRatingsAfterGame(a, b, outcomeForA)` updates both sides symmetrically.
- `updateRatingsAfterGame` in `server/games/store.ts:1309` is the single write
  path. Guards: game finished, `config.rated`, **both** players have an
  `authUserId`, and `isCountedResult(result)`.
- `server/db/ranking-queries.ts` - `queryRanking` ranks one bucket with a
  `ROW_NUMBER()` window, supports paging and jump-to-player.
- `frontend/src/routes/ranking.tsx` - two dropdowns (variant, time control) plus
  a player search. Defaults to standard/rapid.
- The profile page does not display ratings at all; `/ranking` and the pre-game
  lobby (`getRatingForAuthUser`) are the only consumers.

## 2. Decision: a real rating, not an aggregate of the twelve

Two ways to produce a global number:

1. Aggregate the existing 12 rows per user (mean, or deviation-weighted mean).
2. Run a second, independent Glicko-2 chain over the union of all rated games.

**Take (2).** An average of ratings is not itself a rating: it carries no
deviation, it weights a 1-game bucket the same as a 200-game bucket, and two
players with different bucket coverage are not comparable. Option (2) is a
genuine rating with a genuine uncertainty, and it is the only reading of "a
single ranking that reflects every game played" that is actually true.

Cost of (2) over (1) is one extra table and one extra read/write pair per rated
game. Given 32 rated games in the lifetime of the app, that is free.

## 3. Decision: a separate table, not a sentinel row

The tempting shortcut is to reuse `ratings` with `variant = 'all'`,
`time_control = 'all'`. Rejected: both columns are plain `varchar(255)`, so the
sentinel becomes a legal value for every present and future reader - matchmaking
lookups (`getRatingForAuthUser`), the ranking dropdown, any later aggregation.
Nothing in the type system would catch a query that forgot to exclude it. This
is the sentinel-lies problem in CLAUDE.md's implementation rules, applied to a
schema instead of a prop.

New table, one row per user, no dimension columns to lie about:

```ts
// server/db/schema/global-ratings.ts
export const globalRatingsTable = pgTable("global_ratings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.userId, { onDelete: "cascade" }),
  rating: doublePrecision("rating").notNull().default(1500),
  ratingDeviation: doublePrecision("rating_deviation").notNull().default(350),
  volatility: doublePrecision("volatility").notNull().default(0.06),
  peakRating: doublePrecision("peak_rating").notNull().default(1500),
  recordWins: doublePrecision("record_wins").notNull().default(0),
  recordLosses: doublePrecision("record_losses").notNull().default(0),
  lastGameAt: timestamp("last_game_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

Identical to `ratings` minus the two dimension columns. Migration is additive:
new table only, nothing dropped, nothing altered.

## 4. Decision: dual update at game end, against the opponent's _global_ state

In `updateRatingsAfterGame`, after the existing per-bucket update, run a second
`newRatingsAfterGame` over the two players' **global** states and upsert those.

The subtlety worth stating explicitly: the global update must read the
opponent's global rating, not their bucket rating. Mixing the two chains would
make each update depend on which variant the opponent happened to play most, and
the result would not be a Glicko-2 rating of anything.

Both updates share the existing guards, so eligibility is common: aborted games,
unrated games, and games with a guest or bot on either side continue to move
nothing.

The two chains diverge in a way that is correct rather than surprising: the
global chain sees every game, so its deviation shrinks faster and each result
moves it less. What pooling buys is sample size and cross-variant comparability;
what it gives up is variant-specific calibration, which is a deliberate trade
resting on the product claim that the variants measure one transferable skill.

### 4a. The writes must be one transaction, and must happen at most once

Shared guards give common _eligibility_. They do not give common _durability_,
and an earlier draft of this document wrongly assumed they did. Two defects in
the existing write path, both of which this slice would otherwise double:

**The writes are already splittable.** `updateRatingsAfterGame` reads each
player's state, computes, and then issues two independent upserts inside a
`Promise.all` (store.ts:1420-1435). There is no transaction and no row lock, so a
failure between them leaves one player's rating moved and the other's not. Adding
the global chain turns two independently committing writes into four.

**Nothing makes rating a game idempotent.** `processRatingUpdate` re-reads
`gameState.status === "finished"`, which stays true forever, and there is no
`ratingsProcessed` flag or equivalent - verified by grep, no such guard exists.
Two finish paths interleaving (a timeout racing a resignation) would rate the
same game twice. Note the contrast with persistence, which protects itself with
`onConflictDoNothing` on `game_id`; only the rating path is unguarded.

Required, therefore, before the global chain becomes the default ranking:

1. One `db.transaction` covering both players and both chains: read, compute,
   write, commit or roll back together.
2. Row locking with a deterministic order - `SELECT ... FOR UPDATE` over the two
   users ordered by `user_id` ascending, so two concurrent games sharing a player
   serialize instead of losing an update, and never deadlock.
3. An idempotency key on the game. A `rating_events` table with `game_id` as
   primary key, inserted inside the same transaction with `onConflictDoNothing`:
   if the insert reports no row, the game was already rated and the transaction
   rolls back without touching anything.

Point 3 fixes a pre-existing defect rather than one this slice introduces, so it
is scope this task did not ask for. It is ~15 lines and it is the difference
between a flagship rating that can silently double-count and one that cannot;
**flagged to Nil as an explicit scope addition** rather than absorbed silently.

## 5. Decision: backfill by chronological replay

Seed the new table by replaying history rather than starting everyone at 1500 -
otherwise the flagship view launches empty while the per-variant views it
replaces have data.

Replay every game where `games.rated = true` and **both** `game_players.user_id`
are non-null and distinct, ordered by `games.started_at, games.game_id`, feeding
each through the same `newRatingsAfterGame`. Derive `peak_rating` as the running
max, the win/loss record from `outcome_rank` (0.5/0.5 on a tie), and
`last_game_at` as the final `started_at`. The script validates as it goes -
exactly two player rows per game, both users non-null and distinct, a recognised
outcome - and aborts loudly rather than guessing on a malformed row. Script under
`scripts/`, following the shape of `scripts/backfill-campaign-completions.ts`;
idempotent by recomputing from scratch and overwriting, never by adding to what
is there.

**What the replay is, and what it is not.** It reconstructs a deterministic
Glicko-2 chain from _persisted eligible history_. It does **not** reproduce the
sequence of live rating events, and this document previously claimed it did. Two
independent reasons, both verified in the code rather than assumed:

1. **Eligibility is shared; durability is not.** Every finish path in
   `game-socket.ts` awaits `processRatingUpdate` and only then calls
   `persistCompletedGame` - lines 263/265, 405/407, 1100/1102, 1149/1151,
   1341/1343, 1522/1524, 1907/1909 - and the persistence call sits inside a
   `try/catch` that logs and swallows (game-socket.ts:264-271). Ratings commit
   first; if persistence then fails, the game moved a rating and left no row.
   The pre-fix abort incident recorded at store.ts:1366 is one known cause of
   divergence, not the only possible one.

   (The reviewer also flagged `persistGame`'s `startedAt == null` exit as an
   extra gap. Checked: `startedAt` is set on the first move
   (store.ts:958-965), so `startedAt == null` implies `moveCount == 0`, which
   makes the result `aborted` and stops the rating path too. That particular
   exit is genuinely redundant. The try/catch above is not, and is sufficient
   on its own to break the invariant.)

2. **Only start time is stored.** Live updates apply in completion order;
   `games` records `started_at` and no finish timestamp. Glicko-2 is
   path-dependent, so a replay ordered by start time can differ from the live
   order whenever two games overlap. Ordering by `(started_at, game_id)` makes
   the replay _deterministic and reproducible_, which is what is actually
   needed; it does not make it _identical_ to what happened.

The practical consequence: the global rating is a fresh, defensible number
computed from the history the database actually holds. It is not arithmetically
reconcilable with today's per-variant ratings, and no test should assert that it
is.

### 5a. Cutover: an idempotent backfill, run once on each side of the switch

Recomputing and overwriting `global_ratings` while games are finishing can erase
a live update or count it twice. An earlier draft sequenced the deploy as
"backfill, then ship the live writer" and called that sufficient. It is not:
a game finishing _after_ the backfill has read its rows and _before_ the writer
is live is written by nobody and is permanently absent. That is an omission
race rather than an overwrite race, and "the backfill takes under a second"
does not shrink the deployment interval that follows it.

What closes it, without a maintenance gate, is making the backfill safe to run
more than once and running it on both sides of the switch:

1. Deploy schema, `rating_events`, and the live writer together. `GLOBAL_RATINGS_ENABLED`
   is unset, and the flag is **opt-in** (`=== "true"`), so an absent variable
   means off. That direction is the whole safety premise: a default of "on when
   unset" would silently defeat this the first time someone forgot to set it.
2. Run the backfill. Inside ONE transaction it takes the `global_ratings` table
   lock **first**, then reads history through that same transaction, replays,
   deletes the table, rebuilds it, and inserts a `rating_events` row for every
   replayed game. Locking before reading is load-bearing: with the read outside
   the lock, a live game could commit between snapshot and lock and then be
   erased by the overwrite while its ledger row survived, making it
   unapplicable forever.
3. Set `GLOBAL_RATINGS_ENABLED=true` and **restart the service**. This is not a
   live config flip - `process.env` is read by a running process, not pushed to
   one - so it is a deploy-shaped step and should be planned as one.
4. **Run the backfill again.** Any game that finished during the window in step
   3 is in `games` by then, so the second run includes it.

Re-running is safe precisely because the backfill recomputes from scratch and
rebuilds: it deletes every global row under the lock before writing the replay
result, so a row the replay does not produce cannot survive a run. A game rated
live and a game replayed produce the same state, and neither is counted twice.
The `rating_events` insert uses `onConflictDoNothing`, so the second run adds
only what the first one missed.

The lock also composes with the live writer rather than fighting it. A live
transaction locks its two user rows, writes its bucket, and then blocks on
`global_ratings`. Because persistence happens only after rating completes, a
game blocked at that point is not yet in `games` and so is not in the backfill's
snapshot; when the backfill commits, that transaction resumes, reads the
freshly rebuilt state, and applies itself exactly once.

Why presence in `games` is the right test for "already counted": ratings commit
_before_ persistence on every finish path (section 5), so a row in `games`
implies its rating transaction has already committed. The ordering that made
the replay imperfect is the same ordering that makes this cutover sound.

## 6. Decision: the UI cannot express an illegal combination

The global rating spans time controls too, so "all variants + rapid only" has no
stored value and must not be selectable.

- The **Variant** select gains a leading `All variants` option, which becomes the
  page default.
- When it is selected, the **Time Control** select is hidden (not disabled with a
  stale value showing, and not silently ignored).
- Row click currently navigates to past-games filtered by variant + time control;
  in global mode it navigates filtered by player only.

Contract change in `shared/contracts/ranking.ts` - make the illegal state
unrepresentable rather than validated at runtime:

```ts
const pagination = { page, pageSize, player }; // shared, so the two stay in step

export const rankingQuerySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global"), ...pagination }).strict(),
  z
    .object({
      scope: z.literal("variant"),
      variant,
      timeControl,
      ...pagination,
    })
    .strict(),
]);
```

`.strict()` on both branches is load-bearing, and a plain `z.object` would not
do. Zod strips unknown keys by default, so `?scope=global&timeControl=rapid`
would validate cleanly and silently discard `timeControl` - the parsed value
would be legal while the request that produced it was not. Since the point of
the union is that the illegal combination cannot be expressed, it should be
rejected at the boundary, not quietly tidied up.

The route must narrow on `query.scope` before reading any variant-only field;
after `zValidator` the parsed type is a union, so TypeScript enforces this.

`RankingRow` and `RankingResponse` are unchanged - a global row has the same
shape as a bucket row - so the table component needs no change beyond the
filters and the row-click handler.

`queryRanking` dispatches on `scope`: the global branch selects from
`global_ratings` with the same `ROW_NUMBER()` window and no `where` on variant.
The two branches share the paging and jump-to-player logic.

## 7. Explicitly out of scope, proposed as follow-ups

1. **Rate logged-in-human vs bot games against fixed bot anchors.** This is the
   change that would actually populate the leaderboard, and the Elo tournament
   work already gives defensible anchor ratings for the served checkpoints. It
   needs its own design (anchor drift when a bot's model is swapped, whether bots
   appear as rows). Worth filing regardless of the outcome here.
2. **Retiring the per-variant view.** Kept as a secondary view: it is already
   built, costs nothing, and is useful for checking the global number against
   its parts while the feature is new. Revisit once there is usage to judge by.

## 7a. Provisional ratings: badge, do not hide

Ordering purely by rating lets a 1-game player with deviation 290 outrank a
200-game player. Three options were on the table - hide high-deviation players,
sort by the conservative `rating - 2*deviation`, or badge them.

**Badge them.** Hiding is self-defeating with three rated humans: it would
recreate the empty page this task exists to improve. Sorting by a conservative
score is worse than it looks - the column would say "Rating" and the order would
follow a different number, which is the kind of quiet mismatch that makes people
distrust a leaderboard. A "provisional" marker on rows whose deviation is still
above a chosen threshold of 110 says the same thing honestly and costs one extra
field on `RankingRow`. (110 is _our_ threshold, not a standard: Glicko defines
RD but mandates no particular provisional cutoff, and the doc should not imply
otherwise.)

(Pre-existing in the per-variant view too, but the global view makes it the
first thing a visitor sees, so it is handled here rather than deferred.)

## 7b. Testing, given no container runtime on this box

`bun run test:mac` is 22 pass / 12 fail here, and all 12 failures are the same
`Could not find a working container runtime` - the integration tests stand up an
ephemeral Postgres through testcontainers, and this machine has no Docker.
`tests/integration/ranking.websocket.test.ts` is exactly the test this slice
would extend, and it cannot run here.

That is a constraint on the design, not just on the workflow. So: keep the
rating arithmetic in a pure function, with the database confined to loading rows
and writing results.

The signature has to advance existing state rather than compute a whole history,
because the live path starts from whatever the two players already have:

```ts
applyRatedGame(
  current: { a: RatingState; b: RatingState },
  outcomeForA: Outcome,
): { a: RatingState; b: RatingState; records: RecordDelta };
```

The replay is then a fold of that same function over an ordered game sequence
starting from `initialRating()` - so "the backfill agrees with live updates" is
true by construction rather than by inspection, since there is exactly one
implementation of the arithmetic.

That makes the replay unit-testable under `tests/game/`, which runs on this box:
fixed sequence in, expected chain out, including the tie case and the
`(started_at, game_id)` tiebreak. Sorting, query validation, and the writes stay
outside the pure function, and only that wiring needs the DB-backed suite that
Nil's machine and CI can run.

## 8. Files touched

| file                                   | change                                                 |
| -------------------------------------- | ------------------------------------------------------ |
| `server/db/schema/global-ratings.ts`   | new table                                              |
| `drizzle/`                             | generated additive migration                           |
| `server/db/schema/rating-events.ts`    | new table, `game_id` PK, the idempotency key           |
| `server/db/global-rating-helpers.ts`   | get/update, mirroring `rating-helpers.ts`              |
| `server/games/store.ts`                | all four rating writes into one locked transaction     |
| `server/db/ranking-queries.ts`         | `scope` dispatch                                       |
| `shared/contracts/ranking.ts`          | discriminated union                                    |
| `server/routes/ranking.ts`             | pass `scope` through                                   |
| `frontend/src/routes/ranking.tsx`      | All-variants default, conditional TC select, row click |
| `frontend/src/lib/navigation-state.ts` | nav state carries `scope`                              |
| `scripts/backfill-global-ratings.ts`   | one-time replay                                        |
| `tests/`                               | replay determinism + dual-update coverage              |
