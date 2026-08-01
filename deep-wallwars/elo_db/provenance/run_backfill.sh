#!/bin/bash
cd ~/elo_tournament
for N in $(seq 73 -1 60); do
  echo "=== ELO GEN $N $(date -u) ==="
  bash per_gen_update.sh "$N"
done
echo BACKFILL_ALL_DONE
