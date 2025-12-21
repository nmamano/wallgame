# DB Schema

Games will only be stored in the DB when they are finished, which allows us to make more assumptions (all players joined, there is an outcome, etc.) and simplify the schema. The downside is that, if the server crashes, all on-going games will be lost. (I once mentioned this concern to a friend and he said, "But the server shouldn't crash." Fair point...)

```sql
CREATE TABLE games (
    game_id VARCHAR(255) PRIMARY KEY, -- nanoid used in /game/:id
    variant VARCHAR(255) NOT NULL,
    time_control VARCHAR(255) NOT NULL, -- preset or "custom"
    rated BOOLEAN NOT NULL,
    match_type VARCHAR(255) NOT NULL, -- "friend" | "matchmaking"
    board_width INTEGER NOT NULL,
    board_height INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL, -- first move time
    views INTEGER NOT NULL DEFAULT 0,

    -- Precomputed fields by the backend:
    moves_count INTEGER NOT NULL DEFAULT 0
);
```

We split the game data into two. The main table, games, has all the "metadata" about the game, while the game_details table has the actual list of moves and configuration parameters (e.g., variant-specific parameters):

```sql
CREATE TABLE game_details (
    game_id VARCHAR(255) PRIMARY KEY,
    config_parameters JSONB, -- Variant-specific game configuration parameters
    moves JSONB NOT NULL, -- Custom notation for all moves
    FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
);
```

The reason for the split is that the game details take a lot more space than the other fields, and the main use case for storing games is listing them on the "Past Games" page, which doesn't need the game details.

I'm really not sure if this is worth it, though. This may be a premature optimization that adds unnecessary complexity (the two tables now need to be kept in sync and updated together in transactions).

Another interesting decision was whether to store the moves in a SQL moves table or as a JSON blob. I decided to go with the latter because I don't have any need for querying individual moves within a game or across games. We'll always want either all the moves of a single game, or none. One downside is that we need to precompute the moves_count column in the games table.

## Game players

As you can see, the games table does not capture the players or the game outcome. The reason is that the number of players per game depends on the variant, so we couldn't simply have player1 and player2 columns. For the same reason, the outcome is not as simple as "P1 won" or "P2 won" or "draw". Instead, it makes more sense to think about per-player outcomes. Each player outcome consists of a placement and a reason. E.g., a player may have finished 3rd for the reason that the 4th player timed out.

The following table connects games and players:

```sql
CREATE TABLE game_players (
    game_id VARCHAR(255) REFERENCES games(game_id),
    player_order INTEGER NOT NULL, -- 1 for the 1st mover, 2 for the 2nd mover, etc.
    player_role VARCHAR(255) NOT NULL, -- "host" | "joiner"
    player_config_type VARCHAR(255) NOT NULL, -- "you", "friend", "matched user", "bot", "custom bot"
    user_id INTEGER REFERENCES users(user_id), -- NULL for non-logged-in users and built-in bots
    bot_id VARCHAR(255) REFERENCES built_in_bots(bot_id), -- Only non-NULL for built-in bots
    rating_at_start INTEGER, -- Rating at game start, NULL for custom bots
    outcome_rank INTEGER NOT NULL, -- e.g., 1 for winner
    outcome_reason VARCHAR(255) NOT NULL, -- "capture", "timeout", "resignation", "draw-agreement", "one-move-rule"
    PRIMARY KEY (game_id, player_order)
);
```

As we discussed earlier, handling username changes is tricky. If you are watching a past game, do you want to see the current name or the name at the time of the game? In our case, we won't bother with historical names, so we don't need a player_name_at_the_time column. The same for the pawn color and shape they chose at the time. On the other hand, we do want to know their ELO at the time.

Bots are not supported for remote games yet, but the schema keeps bot_id for future use.

# Queries

The query for the Past Games page can be based on the games table only. The game details only need to be brought in when the user watches a specific game.

Past games
We already discussed the 'Past games' page in the Games section. All the filters have an "all" option which is the default:

- Variant
- Rated
- Time control
- Board size: selector with (small / medium / large / all). Games are grouped by board size according to width x height: "Small" (up to 36 squares), "Medium" (up to 81 squares) and "Large" (more than 81 squares).
- ELO: a numerical range (missing from the 'Past games' page screenshot)
- Time period: a date range (missing from the 'Past games' page screenshot)
- Two player filters: filling one gives you all games with that player. Filling both gives you all games including both players.

We also need pagination: we'll show up to 100 games per page and let the user navigate to the next/previous 100-block (see below).

To fill in each row, we need the following data: variant, rated, time control, board width and height, names and ELOs of all the involved players (could be more than 2 depending on the variant), the number of moves, and the date when the game was played. We also need the game id in case the user wants to watch the game.

```sql
-- mandatory: :page_number (1-indexed; for pagination)
-- optional filters: :variant, :rated, :time_control, :board_size, :min_elo,
-- :max_elo, :date_from, :date_to, :player1, :player2
SELECT g.game_id, g.variant, g.rated, g.time_control, g.board_width,
  g.board_height, g.moves_count, g.started_at,
  json_agg(
    json_build_object(
      'player_order', gp.player_order,
      -- TODO: check this line
      'display_name', COALESCE(u.display_name,
                       CASE WHEN b.display_name IS NOT NULL
                            THEN b.display_name
                            ELSE 'Guest' END),
      'rating_at_start', gp.rating_at_start,
      'outcome_rank', gp.outcome_rank,
      'outcome_reason', gp.outcome_reason
    ) ORDER BY gp.player_order
  ) AS players
FROM games AS g
JOIN game_players AS gp USING (game_id)
LEFT JOIN users AS u USING (user_id)
LEFT JOIN built_in_bots AS b USING (bot_id)
WHERE
  (:variant IS NULL OR g.variant = :variant)
  AND (:rated IS NULL OR g.rated = :rated)
  AND (:time_control IS NULL OR g.time_control = :time_control)
  AND (
    :board_size IS NULL
    OR (:board_size = 'small' AND g.board_width * g.board_height <= 36)
    OR (:board_size = 'medium' AND g.board_width * g.board_height > 36 AND g.board_width * g.board_height <= 81)
    OR (:board_size = 'large' AND g.board_width * g.board_height > 81)
  )
  AND (:date_from IS NULL OR g.started_at >= :date_from)
  AND (:date_to IS NULL OR g.started_at <= :date_to)
  AND (
    -- Assumes that if :min_elo is NULL, :max_elo is also NULL
    :min_elo IS NULL
    OR EXISTS (
      SELECT 1 FROM game_players AS gp_elo
      WHERE gp_elo.game_id = g.game_id
        AND gp_elo.rating_at_start IS NOT NULL
        AND gp_elo.rating_at_start >= :min_elo
        AND (:max_elo IS NULL OR gp_elo.rating_at_start <= :max_elo)
    )
  )
  -- Handle player1 filter
  AND (
    :player1 IS NULL
    OR EXISTS (
      SELECT 1 FROM game_players AS gp1
      JOIN users AS u1 USING (user_id)
      WHERE gp1.game_id = g.game_id
        AND u1.display_name = :player1
    )
  )
  -- Handle player2 filter
  AND (
    :player2 IS NULL
    OR EXISTS (
      SELECT 1 FROM game_players AS gp2
      JOIN users AS u2 USING (user_id)
      WHERE gp2.game_id = g.game_id
        AND u2.display_name = :player2
    )
  )
GROUP BY g.game_id
ORDER BY g.started_at DESC
OFFSET (:page_number - 1) * 100
LIMIT 100;
```

When the user selects a game to watch, we need to get the moves and configuration parameters, as well as the players' chosen pawn colors and shapes, which we can pull from the `user_settings` table. This powers GET /api/games/:id for replay, using the same serialized state format as live games.

```sql
-- :game_id is the ID of the game to watch
SELECT g.game_id, g.variant, g.time_control, g.rated, g.match_type, g.board_width,
  g.board_height, g.started_at, g.views, g.moves_count, gd.config_parameters,
  gd.moves,
  json_agg(
    json_build_object(
      'player_order', gp.player_order,
      'player_role', gp.player_role,
      'display_name', COALESCE(u.display_name,
                       CASE WHEN b.display_name IS NOT NULL
                            THEN b.display_name
                            ELSE 'Guest' END),
      'rating_at_start', gp.rating_at_start,
      'outcome_rank', gp.outcome_rank,
      'outcome_reason', gp.outcome_reason,
      'pawn_color', COALESCE(us.pawn_color, 'default'),
      'pawn_settings', (
        SELECT json_object_agg(ups.pawn_type, ups.pawn_shape)
        FROM user_pawn_settings AS ups
        WHERE ups.user_id = u.user_id
      )
    ) ORDER BY gp.player_order
  ) AS players
FROM games AS g
JOIN game_details AS gd USING (game_id)
JOIN game_players AS gp USING (game_id)
LEFT JOIN users AS u USING (user_id)
LEFT JOIN built_in_bots AS b USING (bot_id)
LEFT JOIN user_settings AS us ON u.user_id = us.user_id
WHERE g.game_id = :game_id
GROUP BY g.game_id, gd.config_parameters, gd.moves;
```


# Implementing pagination and filtering

The 'Ranking' and 'Past Games' pages allow the user to essentially inspect the ranking and games tables, respectively, with pagination and filtering. This gives rise to a basic yet tricky software architecture question:

Suppose you have a full-stack app and there is a large table in the DB, which the user can browse in the frontend. We show the user 100 rows at a time, and they can navigate to the next or previous 100 rows. How do you implement this pagination? (We could ask the same about filtering.)

Assumptions:

- The table is not just static data; it gets updates over time.
- The rows must be shown to the user sorted by a specific column, say, 'rank'.
- The backend runs on a single server.

You have 3 main options for where to implement pagination:

1. At the DB level: this is slow, as it requires a DB round-trip every time the user wants to see a new 100-row block, but it guarantees the data is never stale and the backend can remain stateless. We can add a table index on the 'rank' column to speed up the query.

2. At the backend level: if the backend maintains a cached copy of the table (say, as an array), it can return the appropriate range of the array to the frontend, avoiding the DB. This introduces the problem of how to keep the backend's copy of the table always synced with the DB and sorted by 'rank'. For the former, the backend would need to do parallel updates to the DB and the cache. For the latter, if re-sorting on each update is too expensive, something like Redis could take care of it for us.

3. At the frontend level: whenever the user goes to the page, the backend sends the full table (or a big chunk of it), not just the first 100 rows (the backend either maintains a cached copy or queries the DB). This approach makes pagination the most responsive, involving no API calls, but it is also the most stale, as the data won't update until the user refreshes the page. In this case, whether the backend maintains a local copy or not only affects the initial load time.

Each approach has its pros and cons. It comes down to the numbers, like the number of rows, the size of each row, the frequency of updates, the duration of a round-trip, how often each feature is used, and so on.

Did I miss any other options?

Ultimately, there's no right answer, as it also depends on subjective factors like how much you care about user experience vs data freshness, or how much you care about adding engineering complexity.

The same decision about where to do pagination also comes up with row filtering and ordering. It can be done in the DB, backend, or frontend.

For our site, we'll start with the slowest but simplest solution (DB round-trip each time), and we'll optimize as needed.

### Fitlering correctness

Filtering should be done at the DB level so we always return to the frontend the correct number of rows we want with the filter applied.

### Date range picker

We can start with these options:

```ts
"today" | "7days" | "30days" | "365days" | "all";
```

### Skipping games with < 2 moves

When querying the DB for the past games page, we should filter out games with fewer than 2 moves. Those are games that didn't really get started and so showing them is noise.

# Other considerations

### Terminology: Views vs Spectator Count

Two different metrics exist for game viewership:

| Metric | Context | Meaning | Storage |
|--------|---------|---------|---------|
| **Spectator Count** | Live games | Current viewers watching NOW (like Twitch) | In-memory, real-time |
| **Views** | Past games | Total people who have watched replay (like YouTube) | Database, persisted |

These are completely separate concepts and should not be conflated.

### Guest Display Names

Guests cannot set display names. The DB shouldn't allow it. The UI will display "Guest 1" and "Guest 2" based on who moves first. No additional columns needed.

### Non-Goals and Constraints

- **Chat not preserved**: Chat is not implemented yet, but when it is, messages will not be stored in the database.
- **No live updates for past games**: Unlike live spectating, past games don't connect via WebSocket.
- **No deep linking to specific moves**: URLs don't include move position (could be added later with `?move=15`).
- **Spectator counts can be done later**: We can add a spectator count column to the games table later. It's not an MVP feature.
- **Data base indexes for filtering are not needed**: We don't worry about that kind of performance now.
- **View count guarding**: A possible issue is that if some bot / prefetcher hits the endpoint, it increments views. That is OK for now. In the future, we can add a separate "mark view" endpoint or some simple cookie/session guard.

## Relationship with Live Spectating and Player Mode

This feature complements the existing Live Spectating feature and shares components with player mode:

| Aspect | Player (Live) | Live Spectator | Past Game Replay |
|--------|---------------|----------------|------------------|
| Data source | In-memory session | In-memory session | Database |
| Real-time updates | Yes (WebSocket) | Yes (WebSocket) | No (static) |
| Move navigation | ✅ Yes (NEW) | ✅ Yes (NEW) | ✅ Yes (NEW) |
| Can submit moves | At latest position only | ❌ No | ❌ No |
| URL | `/game/:id` | `/game/:id` | `/game/:id` |
| Viewership metric | N/A | Spectator count (live) | Views (cumulative) |
