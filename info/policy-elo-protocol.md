# Policy-Elo measurement limits

Measured and independently reviewed 2026-08-27.

With `samples=1`, `rootNoiseFactor=0`, and policy-argmax move selection, the engine is deterministic. At a fixed start, one pairing therefore has exactly two distinct trajectories, one for each seat direction. More games repeat those trajectories. `randomStartSeed` can change, but it has no effect at a fixed start.

Thus, a larger game count at fixed starts adds no information, and Elo fits saturate. A fixed-start policy-Elo result can record the two seat directions. It cannot become a more precise strength estimate through repeated games.

Random-start conditions are not affected by this fixed-start limit. They produced 12 distinct trajectories in 34 of 35 measured groups.

## Result-rule boundary

Nil's ruling, 2026-09-01:

- Keep existing Elo data points. Do not replay them only because they used the legacy one-move draw rule.
- Every new Elo game generated on or after 2026-09-01 must use the current result rules, in which the legacy one-move draw is removed.
- A plot can contain both legacy-rule and current-rule data. The experiment provenance must identify the result-rule contract for each new data point so the two populations are not presented as one uniform measurement protocol.
