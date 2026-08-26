# Policy Elo explorer

This local Isomux app shows policy-only strength at one search sample. It reads a
generated snapshot from `data/policy-elo.json`; it never reads or writes production
data.

Build the snapshot from the archived evidence:

```bash
python3 ../scripts/build_policy_elo_app_data.py \
  --ssh nilo@desktop-053vvpl-1 \
  --remote-sources /home/nilo/nil/wallgame/deep-wallwars/elo_db/sources \
  --output data/policy-elo.json
```

Run the app:

```bash
PORT=8080 python3 server.py
```

The generations 1-140 evidence connects every supported generation in one rated
component for each condition and bridges the earlier generation 1-36 evidence into
those curves. Generation 0 stays on the plot axis, but it has no artifact.
Generations 1-92 use validated migrated 16-plane artifacts for evaluation, and
generations 93-140 use the native 16-plane contract.

The builder excludes `no-legal-move` outcomes and all rows with legality errors
before fitting. Unknown or unfinished legacy outcomes are excluded too. Each
component stores per-experiment clean and excluded counts plus the immutable raw
filenames, so the JSON snapshot is a reconstructable evidence view rather than only
a plotted total. Legacy rows do not contain sample or noise settings, so the reader
identifies the one-sample, zero-noise evidence by its exact experiment name and
trusts the separate `elo_db/experiments.json` manifest for those settings.
