#!/usr/bin/env bash
# S6 smoke (transformer-ready loop): padded small-board self-play datagen.
#
# Proves: deep_ww -game_columns/-game_rows plays 8x8 games embedded in the
# 12x10 model frame and emits MODEL-FRAME CSVs with the padding walls visible
# in the state planes. Also proves bad dims are rejected nonzero with no data.
#
# Note on priors line length: raw deep_ww CSVs have 2*120 + 4 = 244 priors for
# classic (cat moves only) and 2*120 + 8 = 248 for standard; the Python side
# (data.py) pads classic to 248 for universal training. That padding is
# downstream of this smoke.
set -euo pipefail

cd "$(dirname "$0")/.."
S6="build-tests/s6"
rm -rf "${S6:?}"
mkdir -p "$S6"

echo "=== 1/3 build ==="
cmake --build build-tests --target deep_ww -j8 >/dev/null

echo "=== 2/3 bad dims must fail nonzero and write nothing ==="
if build-tests/deep_ww -model1 simple -output "$S6/bad" -columns 12 -rows 10 \
    -game_columns 14 -game_rows 8 -variant classic -games 1 -samples 1 -j 2 \
    >/dev/null 2>&1; then
    echo "FATAL: bad game dims were accepted" >&2
    exit 1
fi
if [ -d "$S6/bad" ] && [ -n "$(ls -A "$S6/bad" 2>/dev/null)" ]; then
    echo "FATAL: bad run wrote data" >&2
    exit 1
fi
echo "  rejected nonzero, no data written: OK"

echo "=== 3/3 padded self-play (both variants) + CSV verification ==="
for variant in classic standard; do
    build-tests/deep_ww -model1 simple -output "$S6/$variant" -columns 12 -rows 10 \
        -game_columns 8 -game_rows 8 -variant "$variant" -games 4 -samples 1 -j 4 \
        >"$S6/${variant}_log.txt" 2>&1
    .venv/bin/python - "$S6/$variant" "$variant" <<'PYEOF'
import glob
import sys

d, variant = sys.argv[1], sys.argv[2]
files = sorted(glob.glob(d + "/*.csv"))
assert files, f"no CSVs in {d}"
N = 12 * 10  # model-frame cells
expected_priors = 2 * N + (4 if variant == "classic" else 8)

for f in files:
    lines = open(f).read().strip().split("\n")
    state = [float(x) for x in lines[0].split(",")]
    priors = [float(x) for x in lines[1].split(",")]
    assert len(state) == 9 * N, f"{f}: state {len(state)} != {9*N}"
    assert len(priors) == expected_priors, f"{f}: priors {len(priors)} != {expected_priors}"

    walls = state[4 * N : 6 * N]  # plane 4 = right walls, 5 = down walls
    def right_wall(c, r):
        return walls[0 * N + c * 10 + r]
    def down_wall(c, r):
        return walls[1 * N + c * 10 + r]

    n_walls = sum(1 for w in walls if w > 0.5)
    assert n_walls > 0, f"{f}: no padding walls in state"
    if variant == "standard":  # top-left embed: padding right of col 7, below row 7
        assert right_wall(7, 3) > 0.5, f"{f}: right boundary open"
        assert down_wall(3, 7) > 0.5, f"{f}: bottom boundary open"
    else:  # classic bottom-center embed: offsets (2,2)
        assert down_wall(2, 1) > 0.5, f"{f}: top boundary open"
        assert right_wall(1, 5) > 0.5, f"{f}: left boundary open"

print(f"  {variant}: {len(files)} games; state 9x12x10 OK; priors {expected_priors} OK; "
      "padding walls verified at boundary cells")
PYEOF
done

echo
echo "S6 SMOKE PASSED"
