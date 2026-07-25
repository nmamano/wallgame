"""Filter puzzle candidates out of `deep_ww --analyze --analyze_game_file` output.

This implements the REVISED methodology (see info/puzzle-generation.md). It replaces
the candidate bar in analyze_puzzle_spike.py, which used eval-swing + N_jump - those
measure difficulty FOR THE ENGINE, and a superhuman oracle finds human-hard tactics
almost immediately, so there is no jump to time. Kept signals:

  - solution density: share of legal actions whose Q is within DELTA of the best
    (most-visited) action's Q. Low density = one sharp, near-unique best move.
    This is the workhorse "is it a real puzzle" signal.
  - best-move POLICY PRIOR: the raw NN probability on the move deep search picks.
    A low prior means even the network's pattern recognition nearly overlooked it,
    which is the human-relative difficulty proxy (non-obvious = human-hard).
  - decisiveness: |root_q| (is the position actually won/lost enough to matter) and
    the Q gap between best and second-best (how much better the key move really is).

The final eval sets the THEME, not whether it is a puzzle:
  root_q > 0 -> "winning shot" (mover has a win to find)
  root_q < 0 -> "save" (mover is worse; one move holds it)

Usage:
  python3 filter_puzzle_candidates.py <analyze_output.jsonl> [--csv out.csv]
"""

import argparse
import json
import sys
from collections import Counter

DELTA = 0.05  # Q-closeness for "equally good" actions
MAX_PRIOR = 0.20  # best move's NN prior below this = non-obvious
MIN_ABS_Q = 0.30  # |root_q| at/above this = decisive enough to matter

# Uniqueness. Density-as-a-FRACTION does not transfer across board sizes: these
# boards expose ~100 legal actions, so "density <= 0.12" still admits ~12 equally
# good moves, which is not a puzzle. Measured on the first 8x8 run: of 21 positions
# passing the fraction bar, only 9 had a genuinely unique best move, and 7 were
# already-won blowouts (|q|>=0.9) where dozens of moves preserve the win. So gate on
# the ABSOLUTE count of near-best moves plus the Q gap to the second-best move.
MAX_NEAR_BEST = 3  # at most this many actions within DELTA of the best
MIN_GAP = 0.15  # best Q must beat second-best Q by at least this


def analyze_record(r):
    edges = r.get("edges") or []
    if not edges:
        return None

    best = max(edges, key=lambda e: e["visits"])
    qs = sorted((e["q"] for e in edges), reverse=True)
    # Q is from the mover's perspective, so "best" is the max.
    second_q = qs[1] if len(qs) > 1 else qs[0]
    gap = best["q"] - second_q

    near_best = sum(1 for e in edges if abs(e["q"] - best["q"]) <= DELTA)
    density = near_best / len(edges)
    root_q = r["root_q"]

    is_candidate = (
        near_best <= MAX_NEAR_BEST
        and gap >= MIN_GAP
        and best["prior"] < MAX_PRIOR
        and abs(root_q) >= MIN_ABS_Q
    )

    return {
        "game_id": r.get("game_id", ""),
        "move_index": r.get("move_index", -1),
        "player": r.get("player", ""),
        "size": f'{r.get("game_rows", r["rows"])}x{r.get("game_columns", r["columns"])}',
        "root_q": root_q,
        "density": density,
        "best_action": best["action"],
        "best_prior": best["prior"],
        "gap": gap,
        "num_legal": len(edges),
        "near_best": near_best,
        "theme": "winning-shot" if root_q > 0 else "save",
        "is_candidate": is_candidate,
        # Structural position fingerprint for cross-game dedup. The record does not
        # carry the wall state, but the SET of legal actions is determined by the walls,
        # so mover + cat cell + legal-action set identifies the position in practice.
        # (Future runs dedup exactly, inside the engine, before spending the search.)
        "pos_key": (
            r.get("player", ""),
            r["cat"]["row"],
            r["cat"]["col"],
            tuple(sorted(e["action"] for e in edges)),
        ),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--csv")
    args = ap.parse_args()

    rows = []
    with open(args.path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            got = analyze_record(json.loads(line))
            if got:
                rows.append(got)

    # Cross-game dedup: keep the first occurrence of each distinct position.
    seen = set()
    unique = []
    for row in rows:
        if row["pos_key"] in seen:
            continue
        seen.add(row["pos_key"])
        unique.append(row)

    cands = [r for r in unique if r["is_candidate"]]
    dupes_dropped = len(rows) - len(unique)
    cand_before_dedup = sum(1 for r in rows if r["is_candidate"])

    print(f"positions analyzed:      {len(rows)}")
    print(f"distinct positions:      {len(unique)}  ({dupes_dropped} duplicates dropped)")
    print(f"candidates (pre-dedup):  {cand_before_dedup}")
    print(f"CANDIDATES (deduped):    {len(cands)}"
          f"  = {100.0 * len(cands) / max(1, len(unique)):.1f}% of distinct positions")
    print(f"bar: near_best<={MAX_NEAR_BEST}, gap>={MIN_GAP}, best_prior<{MAX_PRIOR}, "
          f"|root_q|>={MIN_ABS_Q} (delta={DELTA})")

    themes = Counter(c["theme"] for c in cands)
    print(f"themes: {dict(themes)}")
    if cands:
        print(f"median gap: {sorted(c['gap'] for c in cands)[len(cands) // 2]:.3f}")

    print("\nsorted by best_prior (most non-obvious first):")
    header = f'{"game":>6} {"mv":>4} {"side":>5} {"q":>6} {"dens":>6} {"prior":>6} {"gap":>6} {"near":>5} {"legal":>6}  best / theme'
    print(header)
    for c in sorted(cands, key=lambda c: c["best_prior"]):
        print(
            f'{c["game_id"][-4:]:>6} {c["move_index"]:>4} {c["player"]:>5} '
            f'{c["root_q"]:>6.2f} {c["density"]:>6.3f} {c["best_prior"]:>6.3f} '
            f'{c["gap"]:>6.2f} {c["near_best"]:>5} {c["num_legal"]:>6}  {c["best_action"]} / {c["theme"]}'
        )

    if args.csv:
        import csv

        with open(args.csv, "w", newline="") as fh:
            cols = [k for k in cands[0] if k != "pos_key"] if cands else []
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            for c in cands:
                w.writerow(c)
        print(f"\nwrote {len(cands)} candidates -> {args.csv}", file=sys.stderr)


if __name__ == "__main__":
    main()
