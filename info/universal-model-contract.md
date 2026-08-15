# Universal neural model contract

The universal model consumes tensors with shape `(batch, 16, columns, rows)`.
Board cells use `column * rows + row` order. The policy output has
`2 * columns * rows + 8` values. There is no pass logit.

## Input planes

| Zero-based plane | Meaning |
| --- | --- |
| 0-3 | Player-relative pawn distance fields |
| 4 | Right-wall occupancy |
| 5 | Down-wall occupancy |
| 6 | The current turn is on its second action |
| 7 | Red is the current player |
| 8 | Standard rules |
| 9 | Classic rules |
| 10 | Animal Cycle rules |
| 11-15 | Reserved; always zero |

Exactly one of planes 8-10 is one. An initial-condition mode does not get a
variant plane. Random Start and authored positions use the plane for their
rules variant.

Classic and Standard keep the pre-migration meanings of planes 0-7. For Animal
Cycle, planes 0-3 contain these animals:

| Player to move | Plane 0 | Plane 1 | Plane 2 | Plane 3 |
| --- | --- | --- | --- | --- |
| Player 1 (Red) | Dog | Cat | Elephant | Mouse |
| Player 2 (Blue) | Cat | Mouse | Dog | Elephant |

The current player's movable animals are planes 0 and 3. This gives the
player-relative capture cycle `0 -> 1 -> 3 -> 2 -> 0`.

## Policy indices

- Indices `0 .. columns*rows-1`: right walls.
- The next `columns*rows` indices: down walls.
- The next four indices: right, down, left, and up moves for the animal in
  input plane 0.
- The final four indices: right, down, left, and up moves for the animal in
  input plane 3.

Classic uses only the first four pawn-move indices. Standard and Animal Cycle
use all eight. C++ can apply a stored zero-action pass, but search and the
neural policy never propose a pass.

## Generation-93 migration

The migration from the nine-plane generation-93 checkpoint is deterministic:

- Copy source stem channels 0-7 to destination channels 0-7.
- Copy source channel 8 to destination Standard plane 8.
- Set destination Classic, Animal Cycle, and reserved channels 9-15 to zero.
- Preserve the stem bias and every later parameter and buffer exactly.

The source checkpoint stays unchanged. `migrate_universal_checkpoint.py`
writes a new checkpoint and a checksum manifest. The CPU parity tool covers
Classic, Standard, and historical custom-position data interpreted with
Standard rules. That historical fixture is test-data semantics only; it is not
a runtime variant or compatibility alias. The fp32 CPU parity gate is a maximum
absolute difference of `2e-6` for policy probabilities and values.
