#!/usr/bin/env python3
"""Audit self-play training CSVs for label corruption.

Would have caught the 2026-07 data bug (fast-forwarded one-hot policy labels
for one seat) years earlier: reports the one-hot label fraction BY SEAT and
fails if either seat exceeds --max-onehot. A seat-rate difference above
--max-gap is recorded as an informational warning because finite self-play
buckets can cross that distribution threshold without corrupt artifacts.

Usage:
  audit_labels.py <data_dir> [--channels 9] [--max-onehot 0.2] [--max-gap 0.1]

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
    parser.add_argument("--channels", type=int, default=9)
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
            cells = len(lines[0].split(",")) // args.channels
        for i in range(0, len(lines) - 2, 3):
            state = lines[i].split(",")
            priors = [float(x) for x in lines[i + 1].split(",")]
            red = float(state[7 * cells]) > 0.5
            nonzero = sum(1 for p in priors if p > 1e-9)
            seat = "red" if red else "blue"
            stats[seat][1] += 1
            if nonzero == 1:
                stats[seat][0] += 1

    rates = {}
    for seat, (onehot, total) in stats.items():
        rates[seat] = onehot / total if total else 0.0
        print(f"{seat}-to-move: {onehot}/{total} one-hot ({100 * rates[seat]:.1f}%)")

    gap = abs(rates["red"] - rates["blue"])
    print(f"seat gap: {100 * gap:.1f}% (max {100 * args.max_gap:.0f}%)")

    failures = []
    for seat, rate in rates.items():
        if rate > args.max_onehot:
            failures.append(f"{seat} one-hot rate {rate:.2f} > {args.max_onehot}")
    if gap > args.max_gap:
        print(
            "AUDIT WARNING: "
            f"seat gap {gap:.6f} > {args.max_gap:.6f} "
            "(informational; training continues)"
        )

    if failures:
        print("AUDIT FAILED: " + "; ".join(failures))
        sys.exit(1)
    print("AUDIT OK")


if __name__ == "__main__":
    main()
