#!/usr/bin/env python3
"""Fit Elo ratings over games.jsonl with a Bradley-Terry (minorization) fit.

Two things this deliberately does NOT do:

  * It does not pin anything to an absolute number. Elo is only defined up to
    an additive constant, so ratings are shifted to put the weakest player at 0
    and nothing pretends to be on an "absolute" scale.
  * It does not merge players across sample counts. Search depth is strength,
    so a model measured at 400 samples and the same weights at 800 samples are
    separate nodes. The key is arch:gen@samples.

It also refuses to silently compare across disconnected components: if two
groups of players never played each other, their ratings are not comparable and
the script says so.

Usage:  python3 scripts/fit_elo.py --variant classic [--exp ID ...]
"""

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def player_key(player, samples):
    tag = f"{player['arch']}:{player.get('gen', player.get('name'))}"
    return f"{tag}@{samples if samples is not None else 'unknown'}"


def load(variant, only_exps):
    experiments = json.loads((ROOT / "experiments.json").read_text())
    wins = defaultdict(float)
    games = defaultdict(lambda: defaultdict(int))
    for line in (ROOT / "games.jsonl").read_text().splitlines():
        row = json.loads(line)
        if row["variant"] != variant:
            continue
        if only_exps and row["exp"] not in only_exps:
            continue
        samples = experiments[row["exp"]]["samples"]
        a = player_key(row["white"], samples)
        b = player_key(row["black"], samples)
        games[a][b] += 1
        games[b][a] += 1
        if row["result"] == "1-0":
            wins[a] += 1
        elif row["result"] == "0-1":
            wins[b] += 1
        else:
            wins[a] += 0.5
            wins[b] += 0.5
    return wins, games


def components(games):
    """Connected components of the who-played-whom graph."""
    seen, groups = set(), []
    for start in games:
        if start in seen:
            continue
        stack, group = [start], []
        seen.add(start)
        while stack:
            node = stack.pop()
            group.append(node)
            for other in games[node]:
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        groups.append(group)
    return groups


def fit(wins, games, players, iterations=3000, prior=0.5):
    """Bradley-Terry via minorization-maximization.

    `prior` gives every player one virtual drawn game against an average
    opponent. Without it a player who never won has a rating of negative
    infinity and the fit dies on log(0) - which is not a hypothetical, the
    weakest generations do get whitewashed by the strongest.
    """
    gamma = {p: 1.0 for p in players}
    for _ in range(iterations):
        new = {}
        for i in players:
            d = sum(games[i][j] / (gamma[i] + gamma[j]) for j in players if games[i][j])
            d += 2 * prior / (gamma[i] + 1.0)
            new[i] = (wins[i] + prior) / d
        mean_log = sum(math.log(new[p]) for p in players) / len(players)
        scale = math.exp(mean_log)
        gamma = {p: new[p] / scale for p in players}
    return {p: 400 * math.log10(g) for p, g in gamma.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", required=True, choices=["classic", "standard"])
    ap.add_argument("--exp", nargs="*", default=None, help="restrict to these experiment ids")
    args = ap.parse_args()

    wins, games = load(args.variant, set(args.exp) if args.exp else None)
    if not games:
        raise SystemExit("no games matched")

    groups = sorted(components(games), key=len, reverse=True)
    if len(groups) > 1:
        print(f"WARNING: {len(groups)} disconnected components - ratings are NOT")
        print("comparable across them. Play cross-group games to join them.\n")
        for i, g in enumerate(groups):
            print(f"  component {i + 1}: {len(g)} players, e.g. {sorted(g)[:4]}")
        print()

    main_group = groups[0]
    elo = fit(wins, games, main_group)
    floor = min(elo.values())
    elo = {p: e - floor for p, e in elo.items()}

    print(f"[{args.variant}] {len(main_group)} players, weakest normalised to 0")
    print("(each player carries one virtual drawn game as a prior)\n")
    for p, e in sorted(elo.items(), key=lambda kv: -kv[1]):
        played = sum(games[p].values())
        print(f"  {p:<28} {e:7.0f}   ({played} games)")

    out = ROOT / f"ratings_{args.variant}.json"
    out.write_text(json.dumps({"variant": args.variant, "normalisation": "weakest=0", "ratings": elo}, indent=2))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
