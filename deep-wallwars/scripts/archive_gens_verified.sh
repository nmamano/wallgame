#!/bin/bash
# Archive generation dirs with index < LIMIT to verified .tar.zst beside them.
# DELETES NOTHING. Verification is a full byte-for-byte tar --diff against the
# originals, not just a file count: equal file counts say nothing about equal
# contents. Aborts if C: drops below the floor (the WSL box's real disk).
#
# training.py now archives generations as they leave the training window, so
# this is for runs that have FINISHED and will never call training.py again -
# e.g. reclaiming the ResNet control run's data after it ended at model_36.
#
# Deleting the originals afterwards is a separate, human step: read the
# manifest and remove only the dirs it marks VERIFIED.
#
# Usage: archive_gens_verified.sh <data-dir> <limit> [threads]
set -uo pipefail
DATA=${1:?data dir}; LIMIT=${2:?limit}; THREADS=${3:-8}
MIN_FREE_MB=2000
MANIFEST="$HOME/archive_$(basename "$DATA")_manifest.txt"
LOG="$HOME/archive_$(basename "$DATA").log"
cd "$DATA" || exit 1
host_free_mb() { df -BM --output=avail /mnt/c 2>/dev/null | tail -1 | tr -d " M"; }
: > "$MANIFEST"
echo "start $(date -Is) data=$DATA limit=$LIMIT C_free=$(host_free_mb)MB" | tee -a "$MANIFEST" "$LOG"
ok=0; bad=0; skip=0
for d in $(ls -1d generation_*/ 2>/dev/null | sed "s#/##" | sort -V); do
  n=${d#generation_}; n=${n%%_*}
  case $n in ""|*[!0-9]*) continue;; esac
  [ "$n" -ge "$LIMIT" ] && continue
  [ -e "$d.tar.zst" ] && { skip=$((skip+1)); continue; }
  free=$(host_free_mb)
  if [ -z "$free" ] || [ "$free" -lt "$MIN_FREE_MB" ]; then
    echo "ABORT_LOW_DISK free=${free}MB floor=${MIN_FREE_MB}MB" | tee -a "$MANIFEST" "$LOG"; break
  fi
  t0=$SECONDS
  nfiles=$(find "$d" -type f | wc -l)
  origk=$(du -sk "$d" | cut -f1)
  if ! tar -I "zstd -3 -T$THREADS" -cf "$d.tar.zst.tmp" "$d" 2>>"$LOG"; then
    echo "FAIL_CREATE $d" | tee -a "$MANIFEST" "$LOG"; bad=$((bad+1)); continue
  fi
  mv "$d.tar.zst.tmp" "$d.tar.zst"
  members=$(tar --zstd -tf "$d.tar.zst" 2>>"$LOG" | wc -l); lrc=$?
  if [ "$lrc" -ne 0 ] || [ "$members" -ne "$((nfiles+1))" ]; then
    echo "FAIL_COUNT $d members=$members expected=$((nfiles+1)) rc=$lrc" | tee -a "$MANIFEST" "$LOG"; bad=$((bad+1)); continue
  fi
  if ! tar --zstd -df "$d.tar.zst" >>"$LOG" 2>&1; then
    echo "FAIL_DIFF $d" | tee -a "$MANIFEST" "$LOG"; bad=$((bad+1)); continue
  fi
  arck=$(du -sk "$d.tar.zst" | cut -f1)
  echo "VERIFIED $d files=$nfiles orig_kb=$origk arch_kb=$arck secs=$((SECONDS-t0))" | tee -a "$MANIFEST" "$LOG"
  ok=$((ok+1))
done
echo "done $(date -Is) verified=$ok failed=$bad already_present=$skip" | tee -a "$MANIFEST" "$LOG"
