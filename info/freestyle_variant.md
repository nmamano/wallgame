# Freestyle variant

A variant where the cat and mice start at random places, and there are some starting walls.

## Rules

The rules of the game are the same as Standard, except for the starting position:

- The board size is fixed to width 12 and height 10.
- Player 1's cat and mouse start at random cells on columns a-d (they can even be the same). If the mouse ends up above the cat, closer to the top of the board (meaning higher row number in in-game coordinates), flip the cat and mouse so the cat is above.
- Player 2's cat and mouse start at horizontally symmetric cells on columns i-l.
- Pawns never spawn in the 4 central columns (e-h).
- A random number of walls is chosen between 4 and 10 for the left side. The walls are then placed randomly on the left half of the board (columns a-f). Walls are placed one by one, randomly, retrying if the wall is not legal (it will enventually succeed).
- Horizontally symmetric walls are placed on the right half of the board (columns g-l).
- Those walls have a neutral color and do not belong to any player.

The starting position has symmetry across the vertical midline between f and g.

## UI changes

- In the Settings page, we'll hide the board dimensions setting for this variant.
- In the Ranking, Past Games, and Live Games pages, we'll include this variant in the filters.
- In the game setup page, when selecting this variant, we'll hide the board dimensions setting.

## Server changes

- The server decides the starting position and the walls. It is the single source of truth for all randomness, just like choosing starting player.
- The server must guarantee that the generated position is legal under Standard rules plus these constraints, not assume generation implies legality.

## Other notes

- The generated position must be serializable and replayable, especially for Past Games and Live Games. This implies storing the fully materialized initial state.
- Freestyle has fixed dimensions and ignores any board-size inputs.
- Freestyle does not share ELO with Standard. It has its own ladder.

# Implementation Approach

Implement Freestyle as a first-class variant with a shared generator for the randomized initial state, keep the server authoritative for online games, persist the generated start so replays/past games are accurate, and hide/override board size to the fixed 12x10 in UI + config.

## Approach

- Add freestyle to shared variant types and API validation.
- Create a shared "freestyle setup" helper that builds pawns + walls with symmetry and legality checks, with RNG injection for determinism in tests.
- Normalize config to fixed 12x10 for freestyle on both server (authoritative) and client (local games + UI).
- Persist the generated initial state so history/replays can reconstruct the real starting position.

## Shared domain + contracts

- `game-types.ts`: add "freestyle" to Variant and update the comment to include the new rule set.
- `games.ts`: extend `variantValues` to include "freestyle" so create/join/query schemas accept it.
- `game-state.ts`: allow an optional initial state (pawns + walls) in the constructor and expose a `getInitialSnapshot()` helper so history/replay can use the true start.
- `grid.ts`: we want neutral starting walls, so store a neutral owner sentinel and return `playerId` as undefined for those walls.
- Implement the neutral-owner path in `grid.ts`.
- `freestyle-setup.ts` (new): generate the initial pawns/walls with symmetry (full rules above), column constraints, and `Grid.canBuildWall` legality checks.

## Server

- `store.ts`: normalize freestyle config to 12x10 and create `GameState` using the shared freestyle generator; rematch should generate a fresh freestyle start.
- `games.ts`: ensure normalization is applied before calling `createGameSession` (if not already done in the store).
- `persistence.ts`: store the generated initial state in `configParameters` (e.g., `initialState: { pawns, walls }`) for replay/past game reconstruction.
- `game-queries.ts`: read `initialState` from `configParameters` and seed the replay `GameState` before applying moves; update `normalizeVariant` to accept "freestyle".
- `game-socket.ts`: include "freestyle" in `getPlayersPerTeam` so the variant list stays explicit.

## Frontend (setup + settings)

- `game-configuration-panel.tsx`: add "Freestyle" to the variant select and hide board-dimension inputs when variant === "freestyle" (optionally show a fixed "12x10" label).
- `game-setup.tsx`: add freestyle to the variant selector/description, hide board size inputs for freestyle, and force boardWidth=12, boardHeight=10 when the variant changes.
- `use-settings.ts`: when the variant is freestyle, clamp board size to 12x10 and skip saving size overrides for that variant.

## Frontend (state + history + board)

- `use-game-page-controller.ts`: for local games, call the shared freestyle generator and pass its initial state into `GameState`; for online games, rely on server-provided serialized state only.
- `game-state-utils.ts`: hydrate `GameState` with the serialized initial pawns/walls so history builds from the correct start; use that same base when reconstructing history entries.
- `history-utils.ts`: accept the initial snapshot (from `GameState.getInitialSnapshot()`) so cursor -1 shows the real randomized start.
- `board.tsx`: walls can be neutral (playerId undefined), so render them with a neutral placed-wall color instead of transparent.

## Frontend (filters + nav state)

- `ranking.tsx`: add freestyle to filter types and options.
- `past-games.tsx`: add freestyle to filter types and options.
- `live-games.tsx`: add freestyle to filters and fix board-size display to use width/height (important for 12x10).
- `navigation-state.ts`: include "freestyle" in the zod enums for ranking/past-games nav state.
- `tanstack-history.d.ts`: update the history state unions to include freestyle.

## Test

- Add an integration test for freestyle:
  1. Generate an actually random starting position for the game. 
  2. Check that starting walls are neutral.
  3. Do a couple of "pass" moves and end the game by draw.
  4. Query past games and check that the starting position is the same.

## Optional docs/tests

- `learn.tsx`: expand the Freestyle blurb to mention fixed 12x10 + starting walls.
- `freestyle-setup.test.ts` (new): validate symmetry, central-column exclusion, and wall legality.
- `tests/integration/*` (as needed): add/adjust variant-filter cases if any schema/type checks start failing.
