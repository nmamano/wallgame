# 10 Wall variant (`tenwall`)

A race variant on a fixed 9x9 board. Each player has **one pawn** and a supply of **ten
walls**. On your turn you take **one** action: step your pawn one square, or place a wall.
You win by reaching any square on the far row.

These are the rules of Quoridor, which is a Gigamic product. Game mechanics are not what a
trademark protects - the name is - so we implement the rules under our own name and do not
use theirs in the product, in copy, or in URLs.

**Status: planned, not started** (2026-08-05). Nothing in this document is implemented yet.

## Naming

- Identifier: **`tenwall`**. It becomes a URL path segment, a `varchar` value in the DB, part
  of the ratings primary key, and a member of the `Variant` union. A leading digit is
  friction in all four, so the identifier is alphabetic.
- Display name: **"10 Wall"**.

## Rules, as a delta from Classic

Classic is the closest existing variant (race to a fixed goal), so the spec is easiest to
read as a diff against it.

| | Classic today | 10 Wall |
| --- | --- | --- |
| Board | configurable, 8x8 default | **fixed 9x9**, not user-configurable |
| Actions per turn | 2 | **1** |
| Wall supply | unlimited | **10 per player** |
| Wall length | **1 edge** (`{cell, orientation}`) | **2 edges**, and no two walls may cross |
| Goal | one specific cell (`home`) | **any cell in the far row** |
| Pawns per player | 2 (a cat plus a frozen `home`) | **1** |
| Pawn interaction | pawns ignore each other | **jump over an adjacent opponent** |
| Move shape | 1 or 2 steps, including a diagonal L | 1 step |

Board size is fixed deliberately. The variant is a specific format, not a configurable
family, and a fixed format makes its rating ladder meaningful sooner. It also keeps the name
literally true, which it would not be if the wall supply had to scale with board area.

## What is already cheap

The engine anticipates more of this than a first read suggests.

- **Wall legality is already a reachability check.** `Grid.canBuildWall`
  (`shared/domain/grid.ts:55`) already refuses any wall that cuts a player off from their
  target, which is the hardest rule in this variant. It needs one generalization: today
  `isValidBoard` (`grid.ts:119`) asks "can this pawn reach *this cell*", and 10 Wall needs
  "can this pawn reach *any cell in this row*". That is a target-set BFS, a small edit to
  the loop already in `Grid.distance` (`grid.ts:130`).
- **Two-cell walls need no `Grid` change.** Store the canonical wall (anchor plus
  orientation) in the variant state and *derive* the two grid edges from it when applying.
  Pathfinding then works untouched. The no-crossing rule falls out of the canonical list as
  "at most one wall per anchor point", since a horizontal and a vertical wall sharing an
  anchor are exactly the crossing case.
- **One action per turn is nearly free.** `actionsRemaining` is already typed `1 | 2`. It is
  simply hardcoded to `2` at the two turn-reset sites, `game-state.ts:640` and `:694`.
  (Caveat: no shipped content currently starts a turn mid-way, so that code path is
  effectively untested in production. Expect to be the first real user of it.)
- **9x9 already validates.** Board sizes 3-20 are accepted (`shared/contracts/games.ts:78`).
- **No database migration.** `variant` is a plain `varchar(255)` with no pg enum and no
  CHECK constraint, in `server/db/schema/games.ts:18`, `ratings.ts:17` and
  `user-settings.ts`. A new variant is a new string; the ratings and settings tables key off
  it automatically.

## What is actually expensive

**The two-pawn assumption.** `Record<PlayerId, { cat: Cell; mouse: Cell }>` is baked into
`SerializedGameState`, the history snapshots, and the undo path
(`shared/domain/game-state.ts:673-701`), and roughly 70 files reference the mouse concept.
10 Wall has one pawn and a goal row, so there is no honest `{cat, mouse}` to supply.

This is generalized **first, as a standalone refactor**, before any 10 Wall code exists -
see "Build order" below.

Do not fake it by parking a sentinel `mouse` on some cell in the goal row. Sentinels look
like real values to every downstream reader (CLAUDE.md, Implementation Quality Rules #3),
and every consumer would then have to know which variants lie.

**Pawn jumping** is net-new movement logic with no analogue in our rules, including the
diagonal case when a wall sits directly behind the jumped pawn. New move generation, a new
notation case, and a new UI affordance.

**The wall budget** is new per-player state that must serialize, restore correctly on
takeback, and render.

## Build order

1. **Pawn-shape generalization.** Pure refactor. `{cat, mouse}` becomes a per-variant shape,
   the same way `variantConfig` was unified in `generalized_variants.md`. No new variant.
   The existing test suite stays green throughout.
2. **10 Wall rules in `shared/domain`, local hot-seat only.** Frontend-only games are
   already a first-class path (it is how bot and hot-seat games work), so this slice needs
   no server, no persistence and no ratings. All the rules work and its tests land here.
3. **The AI** (see below).
4. **Online, later and optional:** server plumbing, persistence, ratings ladder, spectating.

Step 1 comes first because it is the only ordering where a failing test is unambiguous. Do
it in the other order and a regression in standard or classic is indistinguishable from a
10 Wall bug, and you are debugging two changes at once.

## AI

**Vendor, do not train.** The opponent is [`gorisanson/quoridor-ai`](https://github.com/gorisanson/quoridor-ai)
(MIT): pure MCTS with hand-written heuristics and **no neural network**, so there is no
model to train, export or serve. Four difficulty levels, 2,500 to 60,000 rollouts. Its
`worker.js` already runs the search in a Web Worker, so a deep search will not block our
board.

**Vendor `ai.js` only - not `game.js`.** Its source splits into `ai.js` (the AI), `game.js`
(its own Quoridor rules), and `view.js`/`controller.js` (its UI). Taking `game.js` as well
would give us a second rules engine sharing nothing with ours, and 10 Wall would then have
no replays, no notation, no puzzles, no ratings, no spectating and no bot protocol. Keep our
rules engine from step 2 and write an adapter from our `GameState` into the board object
`ai.js` expects.

**Spike first (half a day):** confirm how tightly `ai.js` is coupled to `game.js`'s data
structures. This has been assessed from the repo layout, not from reading the source.

Deep-Wallwars needs no changes for this variant, and no training run is on the path.
Separately and optionally, `state_conversions.hpp:24` already reserves input plane 8 as a
variant plane, so adding these rules to the universal model later is an experiment the
architecture supports - worth running to see whether it affects strength on the other
variants, but not a dependency of shipping.

## UI

- New entry in the variant selector, with board-dimension inputs hidden and forced to 9x9
  (the same treatment Freestyle originally had).
- `board.tsx` renders walls spanning two cells, highlights the goal row, and shows each
  player's remaining wall count.
- Ranking, Past Games and Live Games filters gain the variant.
- Notation (`shared/domain/standard-notation.ts`) needs a form for a two-cell wall and for a
  jump.

## Non-goals

- Configurable board sizes for this variant.
- Puzzles or campaign levels in 10 Wall.
- Using the Quoridor name anywhere user-facing.
