#!/usr/bin/env python3
"""Phase 0b puzzle-gen spike analysis (see info/puzzle-generation.md).

Reads the JSONL emitted by `deep_ww --analyze` and, per start-of-turn position,
computes the two puzzle signals and flags candidates:

  - eval jump: how much the root eval moved as the search deepened. A large,
    late-appearing swing = a non-obvious tactic. We report the swing magnitude
    and N_jump (visits to get within JUMP_SETTLE of the final eval).
  - solution density: fraction of legal actions whose Q is within DELTA of the
    best (most-visited) action's Q. Low density = a sharp, unique-ish tactic.

Sign handling: edge `q` is the CHILD node value (one ply deeper), so we anchor
on the *most-visited* edge as "the engine's move" and measure other edges'
closeness to it — no perspective flip needed. The trajectory `q` is the root
value; we only use its swing magnitude, which is sign-agnostic.

Usage: python3 analyze_puzzle_spike.py spike_8x8_classic.jsonl [more.jsonl ...]
"""
import json
import sys

DELTA = 0.05          # Q-closeness for "equally good" actions (density numerator)
MIN_VISITS = 5        # ignore barely-explored edges when counting good actions
JUMP_SWING = 0.30     # min eval swing (start->end of search) to call it a "jump"
DECISIVE = 0.50       # |final eval| this high => winning-shot; else save/sharpen
LOW_DENSITY = 0.12    # density at/below this = sharp enough to be a puzzle
JUMP_SETTLE = 0.10    # trajectory within this of final counts as "settled"
MIN_NJUMP = 6000      # a real tactic needs meaningful search to appear (not trivial)


def analyze_record(r):
    traj = r.get("trajectory", [])
    edges = r.get("edges", [])
    num_legal = r.get("num_legal_actions", len(edges)) or 1
    if not traj or not edges:
        return None

    early_q = traj[0]["q"]
    final_q = traj[-1]["q"]
    swing = abs(final_q - early_q)

    # N_jump: first visit count at which the eval settled near its final value.
    n_jump = traj[-1]["visits"]
    for pt in traj:
        if abs(pt["q"] - final_q) <= JUMP_SETTLE:
            n_jump = pt["visits"]
            break

    best = max(edges, key=lambda e: e["visits"])
    good = [e for e in edges
            if e["visits"] >= MIN_VISITS and abs(e["q"] - best["q"]) <= DELTA]
    density = len(good) / num_legal

    # A puzzle-worthy position: the deep search substantially changed the assessment
    # (large swing), it took real search to see it (Njump), and there is a sharp/unique
    # best move (low density). The final eval only sets the THEME, not whether it's a
    # puzzle: decisive => winning-shot; otherwise a defensive save / sharp resource.
    is_candidate = (swing >= JUMP_SWING and density <= LOW_DENSITY
                    and n_jump >= MIN_NJUMP)
    ptype = "win" if abs(final_q) >= DECISIVE else "save"

    return {
        "move_index": r.get("move_index"),
        "player": r.get("player"),
        "variant": r.get("variant"),
        "early_q": early_q,
        "final_q": final_q,
        "swing": swing,
        "n_jump": n_jump,
        "n_max": traj[-1]["visits"],
        "difficulty": n_jump / traj[-1]["visits"],
        "best_action": best["action"],
        "best_visits": best["visits"],
        "good_actions": len(good),
        "num_legal": num_legal,
        "density": density,
        "candidate": is_candidate,
        "ptype": ptype,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    rows = []
    for path in sys.argv[1:]:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                a = analyze_record(json.loads(line))
                if a:
                    a["_src"] = path.split("/")[-1]
                    rows.append(a)

    if not rows:
        print("No analyzable records found.")
        return

    print(f"{'src':22} {'mv':>3} {'plr':4} {'earlyQ':>7} {'finalQ':>7} "
          f"{'swing':>6} {'Njump':>7} {'diff':>5} {'good/legal':>11} {'dens':>5} {'best':>10}  cand")
    print("-" * 110)
    for a in rows:
        print(f"{a['_src']:22} {a['move_index']:>3} {a['player']:4} "
              f"{a['early_q']:>7.3f} {a['final_q']:>7.3f} {a['swing']:>6.3f} "
              f"{a['n_jump']:>7} {a['difficulty']:>5.2f} "
              f"{str(a['good_actions'])+'/'+str(a['num_legal']):>11} "
              f"{a['density']:>5.2f} {a['best_action']:>10}  "
              f"{('*** ' + a['ptype']) if a['candidate'] else ''}")

    cands = [a for a in rows if a["candidate"]]
    n_win = sum(1 for a in cands if a["ptype"] == "win")
    swings = [a["swing"] for a in rows]
    dens = [a["density"] for a in rows]
    print("-" * 110)
    print(f"positions: {len(rows)} | candidates: {len(cands)} "
          f"({n_win} winning-shot, {len(cands)-n_win} save/sharpen) "
          f"| swing avg {sum(swings)/len(swings):.3f} max {max(swings):.3f} "
          f"| density avg {sum(dens)/len(dens):.3f} min {min(dens):.3f}")
    print(f"candidate filter: swing>={JUMP_SWING} AND density<={LOW_DENSITY} "
          f"AND Njump>={MIN_NJUMP} (delta={DELTA}); ptype win if |final|>={DECISIVE}")


if __name__ == "__main__":
    main()
