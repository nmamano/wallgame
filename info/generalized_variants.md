Vertical integration feature:

We want to make the Standard and Classic variants more general, by adding additional configuration settings. These would be classified as "variant-specific" settings, like the board dimensions.

1. Instead of the pawns starting at the corners (including cats, mice for standard, and homes for classic), the pawn starting positions are part of the variant-specific configuration.
2. Instead of the board starting with no walls, the set of starting walls is part of the variant-specific configuration (these are neutral walls, analogous to freestyle).

These settings are not configurable from the "Create game" page, so, nothing changes as far the user is concerned. This feature adds flexibility that will be helpful later (e.g., to create special puzzles which follow the standard-variant rules but have a specific initial configuration).

Variant definitions are in the shared/ part of the codebase, so this change will touch frontend and backend.

## Validation

- The starting position must be legal under the rules of the variant:

- Cats must be able to reach their goal/mouse.
- A cat can't start in the same cell as the mouse/goal they must reach to win.


## DB

It will also require a DB migration to properly store full configurations for all games.

Logically, we can break the migration into 3 steps:
1. Add the fields as non-mandatory
2. Backfill existing data with the default parameters
3. Mark the fields as mandatory (should be consistent with freestyle variant).

If it's easier, we can do a single migration that writes defaults inline (using SQL COALESCE or direct inserts).

All variant-specific configurations are stored as jsonb in the DB. 

Note: Incidentally, Standard and Freestyle now have basically the same variant-specific configuration. They only differ in how they are initialized (corners vs randomly). That's not an invariant that needs to be enforced, it's just a coincidence. The reason they are still different variants is that we want different ELOs for them.

- The schema for the starting position should be like the one for Freestyle.
- There's nothing to do for puzzles yet. Out of scope.

### Current DB Schema

`game-details.ts`:4-10 stores variant config:

```
configParameters: jsonb("config_parameters"), // nullable
```

`persistence.ts`:136-142 shows what's stored:

```
const configParameters = {
  timeControl: session.config.timeControl,
  initialState: state.getInitialState(),  // <-- key field
  ...(session.config.variant === "survival" ? { survival: ... } : {}),
};
```

### The `GameInitialState` Schema

`game-types.ts`:217-220:

```
export interface GameInitialState {
  pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;
  walls: WallPosition[];
}
```

For Standard, we can copy it directly.

For Classic, we need to adapt it.

Variants cannot be expected to have type-compatible configs. We should split it:

```ts
export interface StandardInitialState {
  pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;
  walls: WallPosition[];
}

export interface ClassicInitialState {
  pawns: Record<PlayerId, { cat: Cell; home: Cell }>;
  walls: WallPosition[];
}

// Replaces SurvivalVariantSettings
export interface SurvivalInitialState {
  cat: Cell;
  mouse: Cell;
  turnsToSurvive: number;
  walls: WallPosition[];
  mouseCanMove: boolean;
}

export type GameInitialState = StandardInitialState | ClassicInitialState | SurvivalInitialState;
```

### GameConfiguration Changes

All variants will use a single unified field for variant-specific config:

```ts
export interface GameConfiguration {
  variant: Variant;
  timeControl: TimeControlConfig;
  rated: boolean;
  boardWidth: number;
  boardHeight: number;
  variantConfig: GameInitialState;  // replaces the old variant-specific fields
}
```

This replaces the current pattern where Survival has a special `survival` field on `GameConfiguration`. The `variantConfig` field holds the appropriate `*InitialState` type based on the variant.

### Persistence Changes

The `configParameters.survival` field goes away. All variant config is stored under `initialState`:

```ts
const configParameters = {
  timeControl: session.config.timeControl,
  initialState: session.config.variantConfig,  // unified field for all variants
};
```

### Default Values for Migration

Default positions for Standard/Classic (corner positions, empty walls):

**Standard (8x8 board):**
- Player 1: cat at top-left (0, 0), mouse at bottom-left (7, 0)
- Player 2: cat at bottom-right (7, 7), mouse at top-right (0, 7)
- Walls: empty array

**Classic (8x8 board):**
- Player 1: cat at top-left (0, 0), home at bottom-right (7, 7)
- Player 2: cat at bottom-right (7, 7), home at top-left (0, 0)
- Walls: empty array

Note: These defaults are board-size dependent. The migration must compute corners based on `boardWidth` and `boardHeight` from the games table.
