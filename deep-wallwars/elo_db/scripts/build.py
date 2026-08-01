#!/usr/bin/env python3
"""Rebuild games.jsonl from everything under sources/.

Idempotent: it always rewrites games.jsonl from scratch, so running it twice
gives the same file. Adding a new experiment means dropping its games under
sources/ and describing it in experiments.json - never hand-editing games.jsonl.

Usage:  python3 scripts/build.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources"
EXPERIMENTS = json.loads((ROOT / "experiments.json").read_text())

# A PGN line looks like:
#   [White "model_36.trt"][Black "model_24.trt"][Result "1-0"] 1. c4 Nf6
PGN_LINE = re.compile(r'\[White "([^"]+)"\]\[Black "([^"]+)"\]\[Result "([^"]+)"\]')
MODEL_NAME = re.compile(r"(?:(rn|tf)_)?model_(\d+)\.trt")


def player_from_filename(name, default_arch):
    """Map a .trt filename to a player identity.

    Legacy files are bare `model_N.trt` with the architecture implied by the
    experiment. Newer ones carry an explicit `rn_`/`tf_` prefix so the two arms
    can share one pool without colliding.
    """
    m = MODEL_NAME.fullmatch(name)
    if not m:
        return {"arch": "bot", "name": name}
    arch, gen = m.groups()
    return {"arch": arch or default_arch, "gen": int(gen)}


def variant_of(path):
    """The variant is encoded only in the file or directory name."""
    text = str(path)
    if "classic" in text:
        return "classic"
    if "standard" in text:
        return "standard"
    raise ValueError(f"cannot determine variant for {path}")


def rows_from_pgn(path, exp_id, exp):
    variant = variant_of(path.relative_to(SOURCES))
    for line in path.read_text().splitlines():
        m = PGN_LINE.search(line)
        if not m:
            continue
        white, black, result = m.groups()
        yield {
            "exp": exp_id,
            "variant": variant,
            "board": exp["board"],
            "white": player_from_filename(white, exp["arch"]),
            "black": player_from_filename(black, exp["arch"]),
            "result": result,
            "source": str(path.relative_to(SOURCES)),
        }


def rows_from_super_results(path, exp_id, exp):
    """Expand W/L/D aggregates into individual rows, flagged as synthetic."""
    data = json.loads(path.read_text())
    opponents = {"classic": "site_bot_8x8_750000", "standard": "site_bot_model_27"}
    for rec in data["results"]:
        for variant, counts in rec.items():
            if variant not in opponents:
                continue
            model = {"arch": exp["arch"], "gen": rec["gen"]}
            bot = {"arch": "bot", "name": opponents[variant]}
            for result, n in (("1-0", counts["w"]), ("0-1", counts["l"]), ("1/2-1/2", counts["d"])):
                for _ in range(n):
                    yield {
                        "exp": exp_id,
                        "variant": variant,
                        "board": exp["board"],
                        "white": model,
                        "black": bot,
                        "result": result,
                        "source": path.name,
                        "aggregate": True,
                    }


def main():
    rows = []
    for exp_id, exp in EXPERIMENTS.items():
        before = len(rows)
        for pattern in exp["sources"]:
            for path in sorted(SOURCES.glob(pattern)):
                if path.suffix == ".json":
                    rows.extend(rows_from_super_results(path, exp_id, exp))
                else:
                    rows.extend(rows_from_pgn(path, exp_id, exp))
        print(f"{exp_id}: {len(rows) - before} games")

    out = ROOT / "games.jsonl"
    with out.open("w") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
    print(f"\nwrote {len(rows)} games to {out}")

    if not rows:
        sys.exit("no games found - is sources/ populated?")


if __name__ == "__main__":
    main()
