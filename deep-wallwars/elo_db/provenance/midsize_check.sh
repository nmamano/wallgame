#!/bin/bash
# Mid-size sanity check (Nil protocol 2026-07-17): before growing dimensions
# PAST the 10x10 tier, verify 8x9 / 9x8 / 9x9 didn't take a big drop.
# Plays model_N vs model_BASE head-to-head at each size, both variants.
# Usage: midsize_check.sh N BASE [games-per-side]   (BASE = last pre-growth peak)
set -uo pipefail
N="${1:?usage: midsize_check.sh N BASE [games]}"
B="${2:?usage: midsize_check.sh N BASE [games]}"
G="${3:-40}"
ENG=$HOME/vs_super_engines
DW=/home/nil/nil/wallgame/deep-wallwars/build-tests/deep_ww
loc() { if [ -f "$ENG/model_$1.trt" ]; then echo "$ENG/model_$1.trt"; else echo "$HOME/elo_tournament/models/model_$1.trt"; fi; }
OUT=$HOME/elo_tournament/midsize_${N}_vs_${B}
mkdir -p "$OUT"
for V in classic standard; do
  for SZ in "8 9" "9 8" "9 9"; do
    C=${SZ% *}; R=${SZ#* }
    LOG="$OUT/${V}_${C}x${R}.log"
    "$DW" -model1 "$(loc $N)" -model2 "$(loc $B)" \
      -columns 12 -rows 10 -game_columns "$C" -game_rows "$R" -variant "$V" \
      -games "$G" -samples 400 -j 22 -seed 7 > "$LOG" 2>&1 \
      || { echo "$V ${C}x${R}: RUN FAIL"; continue; }
    wld=$(grep -oE "Model1 has a W/L/D of [0-9]+/[0-9]+/[0-9]+" "$LOG" | tail -1 | grep -oE "[0-9]+/[0-9]+/[0-9]+")
    python3 - "$V" "${C}x${R}" "$wld" <<'PY'
import sys, math
v, sz, wld = sys.argv[1:4]
w, l, d = map(int, wld.split("/"))
n = w + l + d
score = (w + d / 2) / n
elo = "inf" if score in (0, 1) else f"{400 * math.log10(score / (1 - score)):+.0f}"
flag = "" if score >= 0.36 else "  [BIG DROP?]"
print(f"model vs base | {v} {sz}: {w}/{l}/{d} score {score:.0%} elo {elo}{flag}")
PY
  done
done
