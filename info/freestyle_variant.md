# Freestyle variant

A variant where the cat and mice start at random places, and there are some starting walls.

# Rules

The rules of the game are the same as Standard, except for the starting position:

- The board size is fixed to width 12 and height 10.
- Player 1's cat and mouse start at random cells on columns a-d (they can even be the same). If the mouse ends up above the cat, closer to the top of the board (meaning higher row number in in-game coordinates), flip the cat and mouse so the cat is above.
- Player 2's cat and mouse start at horizontally symmetric cells on columns i-l.
- Pawns never spawn in the 4 central columns (e-h).
- A random number of walls is chosen between 4 and 10 for the left side. The walls are then placed randomly on the left half of the board (columns a-f). Walls are placed one by one, randomly, retrying if the wall is not legal (it will enventually succeed).
- Horizontally symmetric walls are placed on the right half of the board (columns g-l).

The starting position has symmetry across the vertical midline between f and g.

# Implementation: UI

- In the Settings page, we'll hide the board dimensions setting for this variant.
- In the Ranking, Past Games, and Live Games pages, we'll include this variant in the filters.
- In the game setup page, when selecting this variant, we'll hide the board dimensions setting.

# Implementation: Server

- The server decides the starting position and the walls. It is the single source of truth for all randomness, just like choosing starting player.
- The server must guarantee that the generated position is legal under Standard rules plus these constraints, not assume generation implies legality.

# Other

- The generated position must be serializable and replayable, especially for Past Games and Live Games. This implies storing the fully materialized initial state.
- Freestyle has fixed dimensions and ignores any board-size inputs.
- Freestyle does not share ELO with Standard. It has its own ladder.

