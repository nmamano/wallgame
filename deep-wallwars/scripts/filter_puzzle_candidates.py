"""Filter puzzle candidates out of `deep_ww --analyze --analyze_game_file` output.

FILTER V2. The v1 bar produced 5 candidates that Nil playtested: one was trivially
intuitive and three were impossible to guess AND impossible to understand even after the
answer was shown. See info/puzzle-generation.md for the full verdict. The diagnosis:

  v1 selected for moves that are hard to FIND, with nothing requiring them to be
  CHECKABLE. Its difficulty signal was the best move's low policy prior - the moves the
  network's pattern recognition nearly overlooked. That turns out to select for ALIEN
  rather than DEEP: a quiet shaping move whose justification is fifteen plies away.

V2 keeps v1's uniqueness signals (they were right - one clearly-best move, a real gap to
the runner-up) and adds the two things it was missing.

1. THE LINE MUST BE CHECKABLE. Decision D2 in the design doc says to prefer forcing
   lines, and it was never implemented. The engine now emits its principal variation with
   per-step statistics, so we can require the opponent's replies to be near-unique for the
   first few turns. A human solving a puzzle does not evaluate a position, they verify a
   sequence; if the opponent has eight reasonable answers, there is no sequence to verify.

   Forcing is judged from BOTH the count of near-best replies and how many actions the
   search took seriously (`considered`). Deep in a 10k-visit tree most nodes have only one
   or two expanded actions, so "only one good reply" there is search thinness, not a
   forced line - the `considered` floor is what separates the two.

2. THE PAYOFF MUST BE VISIBLE, AND NOT VISIBLE YET. The playtest gave a sharp bracket in
   distance-to-goal, the one quantity a player can literally count on the board:

     changes the count immediately -> obvious, "required no thinking"
     never changes the count       -> inscrutable, "no visible logic"

   So the target is the band between: the key turn must NOT move the count now, and the
   forced line that follows must move it by the end. That is a puzzle with an answer the
   solver can confirm for themselves.

Low prior is demoted from a target to a CAP: it still excludes the blatantly obvious move,
but we stop chasing 0.001, which is what dragged v1 into alien territory.

Also added: an eval-CONVERGENCE gate. The same position scored root_q -0.408 and -0.103
on two runs with identical model, seed and visits (GPU MCTS is not bit-deterministic), and
that moved it across v1's decisiveness gate. A position whose eval is still drifting at
the end of the search has not been measured, only sampled.

Usage:
  python3 filter_puzzle_candidates.py <analyze_output.jsonl> [--csv out.csv] [--funnel]
"""

import argparse
import json
import sys
from collections import Counter

# --- Root position: is there one clearly-best move at all? (kept from v1) ---
DELTA = 0.05  # Q-closeness for "equally good" actions
MAX_NEAR_BEST = 3  # at most this many actions within DELTA of the best
MIN_GAP = 0.15  # best Q must beat the runner-up by at least this

# Absolute counts, never fractions. These boards expose ~80-100 legal actions, so
# "density <= 0.12" still admits ~12 equally good moves, and a fraction does not
# transfer across board sizes (10x12 exposes far more actions than 6x6).

# --- Root position: is the move needed, and is the reading trustworthy? ---
MAX_ABS_Q = 0.85  # above this the game is already decided; dozens of moves preserve it
MAX_PRIOR = 0.60  # a CAP, not a target: drop only the moves the network finds obvious
MAX_DRIFT = 0.05  # eval must have stopped moving over the last chunks of the search

# --- The line: can a human verify it? ---
FORCED_TURNS = 2  # opponent replies that must be near-unique, counted from the top
FORCED_NEAR_BEST = 2  # a reply is "forced" if at most this many actions are near-best
# The search must have weighed at least three alternatives for "only one or two are any
# good" to carry information. Below that it is a statement about the search, not the
# position: 393 of the 1203 opponent nodes in the first 8x8 run had exactly ONE expanded
# action, which looks perfectly forced and means nothing.
MIN_CONSIDERED = 3
MIN_NODE_VISITS = 500  # ...and the node had enough visits for that to mean anything

# --- The payoff, in distance-to-goal (what the solver can count) ---
MAX_IMMEDIATE = 1  # the key turn must not visibly change the race by more than this
MIN_SWING = 2  # ...but the line must, by its end


def near_best_count(edges, floor):
    """Actions within DELTA of the most-visited one, ignoring barely-explored edges.

    Unvisited edges carry q = 0, which is not an evaluation. Counting them makes a losing
    position look like it has dozens of adequate moves (and a winning one look sharp).
    """
    considered = [e for e in edges if e["visits"] >= floor]
    if not considered:
        return 0, 0, 0.0
    best = max(edges, key=lambda e: e["visits"])
    others = [e["q"] for e in considered if e is not best]
    gap = best["q"] - max(others) if others else 0.0
    near = sum(1 for e in considered if e["q"] >= best["q"] - DELTA)
    return near, len(considered), gap


def analyze_record(r):
    edges = r.get("edges") or []
    pv = r.get("pv") or []
    if not edges:
        return None

    best = max(edges, key=lambda e: e["visits"])
    floor = max(1, r["total_visits"] // 100)
    near, considered, gap = near_best_count(edges, floor)
    root_q = r["root_q"]

    # Eval convergence: how far the reading still moved over the last three chunks.
    traj = [t["q"] for t in r.get("trajectory") or []]
    drift = max((abs(traj[-1] - q) for q in traj[-3:]), default=9.0) if traj else 9.0

    # How many of the opponent's replies, from the top of the line, are near-unique.
    mover = r["player"]
    forced_turns = 0
    for step in pv:
        if step["player"] == mover:
            continue
        if (
            step["near_best"] <= FORCED_NEAR_BEST
            and step["considered"] >= MIN_CONSIDERED
            and step["node_visits"] >= MIN_NODE_VISITS
        ):
            forced_turns += 1
        else:
            break

    # Distance-to-goal, from the mover's point of view: + means the mover is ahead.
    opp = "blue" if mover == "red" else "red"
    before = r["dist_before"]
    adv0 = before[opp] - before[mover]
    advs = [s["dist"][opp] - s["dist"][mover] for s in pv if s.get("dist")]
    # advs[1] is the count right after the mover's own turn (a turn is two actions).
    immediate = advs[1] - adv0 if len(advs) > 1 else None
    swing = advs[-1] - adv0 if advs else 0

    gates = {
        "unique": near <= MAX_NEAR_BEST,
        "gap": gap >= MIN_GAP,
        "undecided": abs(root_q) <= MAX_ABS_Q,
        "prior_cap": best["prior"] < MAX_PRIOR,
        "converged": drift <= MAX_DRIFT,
        "forcing": forced_turns >= FORCED_TURNS,
        "not_obvious": immediate is not None and abs(immediate) <= MAX_IMMEDIATE,
        "payoff": swing >= MIN_SWING,
    }

    return {
        "game_id": r.get("game_id", ""),
        "move_index": r.get("move_index", -1),
        "player": mover,
        "size": f'{r.get("game_rows", r["rows"])}x{r.get("game_columns", r["columns"])}',
        # Everything build_puzzle_candidates.ts needs to reconstruct a playable position:
        # the true game size, and the model frame the analyzer embedded it in (its cat cell
        # and action notation are in MODEL coordinates and have to be mapped back down).
        "game_rows": r.get("game_rows", r["rows"]),
        "game_columns": r.get("game_columns", r["columns"]),
        "model_rows": r["rows"],
        "model_columns": r["columns"],
        "cat_model": [r["cat"]["row"], r["cat"]["col"]],
        "best_turn_actions": r.get("best_turn"),
        # The engine's whole expected line, both sides. Reconstructing it as the puzzle's
        # move sequence is what makes the answer inspectable rather than asserted.
        "pv_actions": [
            {"action": s["action"], "player": s["player"], "second": s["second"]}
            for s in pv
        ],
        "root_q": root_q,
        "best_action": best["action"],
        "best_turn": " ".join(r.get("best_turn") or []),
        "best_prior": best["prior"],
        "gap": gap,
        "near_best": near,
        "considered": considered,
        "num_legal": len(edges),
        "drift": drift,
        "pv_len": len(pv),
        "forced_turns": forced_turns,
        "adv_before": adv0,
        "immediate": immediate,
        "swing": swing,
        "theme": "winning-shot" if root_q > 0 else "save",
        "gates": gates,
        "is_candidate": all(gates.values()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--csv")
    ap.add_argument("--json", help="full candidate records, the input to "
                                   "build_puzzle_candidates.ts")
    ap.add_argument("--top", type=int, default=0,
                    help="instead of the pass/fail bar, emit the best N positions that "
                         "clear the hard gates, ranked by how checkable the line is")
    ap.add_argument(
        "--funnel",
        action="store_true",
        help="show how many positions survive each gate, added one at a time",
    )
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

    # The hard gates are correctness requirements, not taste. A position that is already
    # decided, whose eval never converged, whose key turn gives itself away, or whose line
    # never opens a countable advantage is not a puzzle at any threshold - the last one
    # especially: without a payoff the solver has nothing to confirm, which is exactly how
    # v1's candidates failed. What is genuinely tunable is HOW forced and HOW much better,
    # so --top ranks on those two and leaves the rest as requirements.
    if args.top:
        hard = ["unique", "undecided", "converged", "prior_cap", "not_obvious", "payoff"]
        eligible = [r for r in rows if all(r["gates"][g] for g in hard)]
        eligible.sort(
            key=lambda r: (min(r["forced_turns"], 4), round(min(r["gap"], 1.0), 2)),
            reverse=True,
        )
        cands = eligible[: args.top]
        print(f"positions analyzed:  {len(rows)}")
        print(f"clear the hard gates: {len(eligible)}   showing top {len(cands)}")
    else:
        cands = [r for r in rows if r["is_candidate"]]
        print(f"positions analyzed:  {len(rows)}")
    if not args.top:
        print(f"CANDIDATES:          {len(cands)}"
              f"  = {100.0 * len(cands) / max(1, len(rows)):.1f}%")

    order = ["unique", "gap", "undecided", "prior_cap", "converged",
             "forcing", "not_obvious", "payoff"]
    print("\nper-gate survival (each gate on its own):")
    for g in order:
        n = sum(1 for r in rows if r["gates"][g])
        print(f"  {g:<12} {n:>5} / {len(rows)}  ({100 * n / max(1, len(rows)):5.1f}%)")

    if args.funnel:
        print("\ncumulative funnel (gates added in order):")
        live = rows
        for g in order:
            live = [r for r in live if r["gates"][g]]
            print(f"  + {g:<12} {len(live):>5} remaining")

    if cands:
        themes = Counter(c["theme"] for c in cands)
        print(f"\nthemes: {dict(themes)}")
        header = (f'{"game":>6} {"mv":>4} {"side":>5} {"q":>6} {"prior":>6} {"gap":>6} '
                  f'{"near":>5} {"forced":>7} {"adv":>4} {"imm":>4} {"swing":>6}  turn / theme')
        print("\n" + header)
        for c in sorted(cands, key=lambda c: -c["swing"]):
            print(
                f'{c["game_id"][-4:]:>6} {c["move_index"]:>4} {c["player"]:>5} '
                f'{c["root_q"]:>6.2f} {c["best_prior"]:>6.3f} {c["gap"]:>6.2f} '
                f'{c["near_best"]:>5} {c["forced_turns"]:>7} {c["adv_before"]:>4} '
                f'{c["immediate"]:>4} {c["swing"]:>6}  {c["best_turn"]} / {c["theme"]}'
            )

    if args.json:
        with open(args.json, "w") as fh:
            json.dump([{k: v for k, v in c.items() if k != "gates"} for c in cands], fh,
                      indent=1)
        print(f"\nwrote {len(cands)} candidates -> {args.json}", file=sys.stderr)

    if args.csv:
        import csv

        skip = {"gates", "pv_actions", "cat_model", "best_turn_actions"}
        with open(args.csv, "w", newline="") as fh:
            cols = [k for k in cands[0] if k not in skip] if cands else []
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            for c in cands:
                w.writerow(c)
        print(f"\nwrote {len(cands)} candidates -> {args.csv}", file=sys.stderr)


if __name__ == "__main__":
    main()
