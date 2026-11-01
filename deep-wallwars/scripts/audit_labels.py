#!/usr/bin/env python3
"""Audit self-play training CSVs for label corruption (permanent gate).

Would have caught the 2026-07 data bug (fast-forwarded one-hot policy labels
for one seat) years earlier: reports the one-hot label fraction BY SEAT and
fails if either seat exceeds --max-onehot or the seats differ by more than
--max-gap. A seat with no positions FAILS: it was never measured, so it
cannot pass (before 2026-11-01 it scored a clean 0.0%).

--channels is required and must be the plane count the data was written with
(training.py passes MODEL_INPUT_CHANNELS). The seat is read from plane 7,
"red to move". With the old default of 9 on 16-plane data, plane 7 pointed at
the wrong cell, and every audit of 16-plane data put all positions on Blue:
from 98f9d7a4 (2026-08-15) to the last training run that audited, which ended
on 2026-09-01 (task 5d897220).

Usage:
  audit_labels.py <data_dir> --channels 16 [--max-onehot 0.2] [--max-gap 0.1]

Only meaningful on MODEL-driven games with a healthy sample count; games
played with samples=1 (e.g. simple-policy bootstrap) are legitimately one-hot
and should not be audited with default thresholds.
"""

import argparse
import glob
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir")
    parser.add_argument("--channels", type=int, required=True)
    parser.add_argument("--max-onehot", type=float, default=0.2)
    parser.add_argument("--max-gap", type=float, default=0.1)
    parser.add_argument("--max-files", type=int, default=200)
    args = parser.parse_args()

    files = sorted(glob.glob(os.path.join(args.data_dir, "*.csv")))[: args.max_files]
    if not files:
        sys.exit(f"FATAL: no CSVs in {args.data_dir}")

    stats = {"red": [0, 0], "blue": [0, 0]}  # seat -> [onehot, total]
    cells = None
    for f in files:
        lines = [l for l in open(f).read().strip().split("\n") if l.strip()]
        if cells is None:
            width = len(lines[0].split(","))
            if width % args.channels:
                sys.exit(f"FATAL: state row has {width} values, not a multiple of "
                         f"--channels {args.channels}")
            cells = width // args.channels
        for i in range(0, len(lines) - 2, 3):
            state = lines[i].split(",")
            priors = [float(x) for x in lines[i + 1].split(",")]
            red = float(state[7 * cells]) > 0.5
            nonzero = sum(1 for p in priors if p > 1e-9)
            seat = "red" if red else "blue"
            stats[seat][1] += 1
            if nonzero == 1:
                stats[seat][0] += 1

    failures = []
    rates = {}
    for seat, (onehot, total) in stats.items():
        if total == 0:
            print(f"{seat}-to-move: no positions (not measured)")
            failures.append(f"{seat} seat has no positions (wrong --channels, or broken data)")
            continue
        rates[seat] = onehot / total
        print(f"{seat}-to-move: {onehot}/{total} one-hot ({100 * rates[seat]:.1f}%)")

    if len(rates) == 2:
        gap = abs(rates["red"] - rates["blue"])
        print(f"seat gap: {100 * gap:.1f}% (max {100 * args.max_gap:.0f}%)")
        if gap > args.max_gap:
            failures.append(f"seat gap {gap:.2f} > {args.max_gap}")
    else:
        print("seat gap: not measured")

    for seat, rate in rates.items():
        if rate > args.max_onehot:
            failures.append(f"{seat} one-hot rate {rate:.2f} > {args.max_onehot}")
    if failures:
        print("AUDIT FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("AUDIT OK")


if __name__ == "__main__":
    main()
