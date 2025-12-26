# Classic variant

A variant where the mice are called "goals" and are fixed in the bottom corners. You win by reaching your own goal (the opposite corner) before the opponent reaches theirs.

# Rules

The rules of the game are the same as Standard, except that the mouse cannot move.

- Other than that, the game configuration is the same and the starting position is the same.

# Implementation: UI

- In the Ranking, Past Games, and Live Games pages, we'll include this variant in the filters (it may already be there).

# Other

- Classic does not share ELO with Standard. It has its own ladder.

# Implementation Details

## Shared rules (authoritative)

- Enforce the rule in `shared/domain/game-state.ts` so it applies to local play and to server-authoritative play.
  - In `GameState.applyMove(...)`, if `config.variant === "classic"`, reject any action with `type === "mouse"` (throw an error).
  - Keep wall legality unchanged: a wall is legal iff each cat can still reach the opponent mouse (same as Standard). No target swapping in `Grid.canBuildWall(...)`.

## Frontend interaction

- Prevent mouse/goal interaction and show a clear error:
  - In `frontend/src/hooks/use-game-page-controller.ts`, block selecting/dragging/staging moves for mouse pawns when `gameState.config.variant === "classic"`.
  - When the user attempts it (click pawn, drag pawn, or click the mouse cell to select), set `actionError` to `Goal is fixed.` so it renders in the same place as the existing `Illegal wall placement.` message.

## Cursor behavior

- Always show the not-allowed cursor on mice/goals in Classic:
  - In `frontend/src/components/board.tsx`, add a variant-derived flag (or pass `variant`) so the Board can treat mouse pawns as non-interactive in Classic.
  - When active, force the mouse pawn cursor to `cursor-not-allowed` regardless of selection state, and disable drag start for mouse pawns.

## UI filters / ladder

- Verify Classic is selectable/filterable (likely already done):
  - `frontend/src/routes/ranking.tsx`, `frontend/src/routes/past-games.tsx`, `frontend/src/routes/live-games.tsx`, `frontend/src/routes/game-setup.tsx`.
- No ELO sharing changes needed (ratings are already keyed by `variant`).

## Non-goals

- Don’t rename UI copy from “mouse” to “goal”.
- Don’t add tests as part of this change.
