# Ranking

This page consists of a set of filters and a table where rows are filtered by those filters.

The filters are not on the URL or persistent. They are just state, like in the Past Games page.
Design decisions must be aligned with the Past Games page.
This documentation may be a bit outdated relative to the current code, but it describes the vision.

### Ranking filters

The filters do _not_ have an "all" option.

- Variant: default: standard
- Time control: default: rapid
- Player: text field. Default: empty. The player filter acts more like a search box. If filled and the player exists, it only shows the row corresponding to that player and a few rows before and after. If the player does not exist, it shows nothing.

### Ranking columns

- Rank: number starting at 1
- Player: the display name. It updates whenever players change their names delete their accounts.
- Rating: the ELO rating. These are numbers sorted in decreasing order.
- Peak rating: the max ELO rating that player has ever had.
- Record: a string formatted like "10-4" indicating the number of points the player got and lost across all its games.
- First game: a date.
- Last game: a date.

Clicking anywhere on a row takes you to the "Past games" page with the variant, time control, and player filters set. The "rated" filter is also set to "yes".

## DB


ELO ratings are specific to a variant and time control, so we can't keep them in the `users` table.

```sql
CREATE TABLE ratings (
    user_id INTEGER REFERENCES users(user_id),
    variant VARCHAR(255) NOT NULL, -- "standard" or "classic"
    time_control VARCHAR(255) NOT NULL, -- "bullet", "blitz", "rapid", or "classical"
    rating INTEGER NOT NULL DEFAULT 1200,

    -- Precomputed fields by the backend:
    peak_rating INTEGER NOT NULL DEFAULT 1200,
    record_wins INTEGER NOT NULL DEFAULT 0,
    record_losses INTEGER NOT NULL DEFAULT 0,
    last_game_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMPTZ,

    PRIMARY KEY (user_id, variant, time_control)
);
```

### Optimizing the Ranking page

The final four columns in the `ratings` table are needed for the Ranking page (the `First Game` column in the prototype below will be replaced by `Join Date`):

<BlogImage src="/blog/wall-game-ui/v07.png" alt="Ranking" />

These columns are redundant, as they could be computed by aggregating information from the
`games` table. However, it would be expensive to, e.g., look through all the games
of a user to find its peak rating. Instead, the plan is to precompute these columns
in the backend and update them whenever a user finishes a game.

The downside of this approach is that the `games` and `ratings` tables may be in an inconsistent state. For example, if a game somehow disappears from the `games` table, a player may end up with a "3-0" record even though they only have two games in the DB. I think this is OK. First, it's not clear what should happen if a game disappears--it doesn't retroactively change the fact that the player played three games. Second, we can always run a one-off query to fix the precomputed fields.

Instead of having the backend compute these fields, an alternative approach would be to have a cron job that updates them periodically. However, when a user reaches a new peak rating, they probably want it to be reflected immediately in the Ranking.

### Ranking Query

The 'Ranking' page consists of a set of filters and a table where rows are filtered by those filters.

<BlogImage src="/blog/wall-game-ui/v07.png" alt="Showcase" />

The mandatory filters are 'Variant' and 'Time control'.

By default, the ranking shows the top 100 players for that variant and time control. We can use pagination to see more.

To fill in each row, we need the following data: rank, player, rating, peak rating, record wins and losses, user creation date, and date of the user's last game.

There is also an optional 'Player' search box. If filled with a player name and the player exists, it jumps directly to the page (100-block) containing that player. If the player does not exist, it shows nothing.

As mentioned, we'll implement pagination and filtering in the DB. We can add a table index on the `display_name` column to speed up the "player search" query:

```sql
CREATE INDEX ON users (display_name);
```

Here is the full query:

```sql
-- mandatory filters: :variant, :time_control, :page_number (1-indexed; for pagination)
-- optional: :player_name (if provided, overrides page_number)
WITH ranked AS (
  SELECT r.user_id, u.display_name, r.rating, r.peak_rating, r.record_wins,
    r.record_losses, u.created_at, r.last_game_at,
    -- break ELO ties by oldest account
    ROW_NUMBER() OVER (ORDER BY r.rating DESC, u.created_at) AS rank
  FROM ratings AS r
  JOIN users AS u USING (user_id)
  WHERE r.variant = :variant AND r.time_control = :time_control
),
offset_value AS (
  SELECT
    CASE
      WHEN :player_name IS NOT NULL THEN
        COALESCE(
          (SELECT ((rank - 1) / 100) * 100
           FROM ranked
           WHERE display_name = :player_name),
          0
        )
      ELSE
        (:page_number - 1) * 100
    END AS value
)
SELECT * FROM ranked
ORDER BY rank
OFFSET (SELECT value FROM offset_value)
LIMIT 100;
```

We include deleted players in the ranking. They'll just show up as something like "Deleted User 23".
