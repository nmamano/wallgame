#!/usr/bin/env python3
"""Emit an inline SVG line chart of Elo vs generation, one series per architecture.

Written for pasting into chat, which sanitises SVG: presentation attributes only,
no <style>, no script. That also rules out media queries, so the series colours
are a single pair validated against BOTH the light and dark surface rather than
two mode-specific sets. Text and grid ride theme variables so they follow the
host theme.

Usage:  python3 scripts/plot_svg.py <variant> [--exp ID]
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Categorical slots 1 and 2, dark-mode steps. Both pass all six checks on the
# light AND dark surface, which the light steps do not (orange leaves the
# lightness band on dark).
SERIES = [
    ("tf", "Transformer", "#3987e5"),
    ("rn", "ResNet", "#d95926"),
]

W, H = 620, 280
# R holds the end-of-line labels; too small and they clip. T holds the title and
# the y-axis unit, which sit on separate lines.
L, R, T, B = 48, 140, 56, 32


def ratings_for(variant, exp):
    """Refit so the numbers on the chart are never stale relative to games.jsonl."""
    cmd = [sys.executable, "scripts/fit_elo.py", "--variant", variant]
    if exp:
        cmd += ["--exp", exp]
    subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True)
    return json.loads((ROOT / f"ratings_{variant}.json").read_text())["ratings"]


def series_points(ratings, arch):
    out = {}
    for key, elo in ratings.items():
        if not key.startswith(f"{arch}:"):
            continue
        gen = key.split(":", 1)[1].split("@")[0]
        if gen.isdigit():
            out[int(gen)] = elo
    return sorted(out.items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("variant", choices=["classic", "standard"])
    ap.add_argument("--exp", default=None)
    args = ap.parse_args()

    ratings = ratings_for(args.variant, args.exp)
    data = [(arch, label, colour, series_points(ratings, arch)) for arch, label, colour in SERIES]
    data = [d for d in data if d[3]]
    if not data:
        raise SystemExit("no series found")

    all_gens = [g for *_, pts in data for g, _ in pts]
    all_elo = [e for *_, pts in data for _, e in pts]
    x_min, x_max = min(all_gens), max(all_gens)
    y_max = max(all_elo)
    y_top = int((y_max // 250 + 1) * 250)

    def px(g):
        return L + (g - x_min) / (x_max - x_min) * (W - L - R)

    def py(e):
        return H - B - e / y_top * (H - T - B)

    out = [
        f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}" xmlns="http://www.w3.org/2000/svg" '
        f'font-family="system-ui, sans-serif">'
    ]

    # Recessive horizontal grid with y labels.
    for i in range(5):
        e = y_top * i / 4
        y = py(e)
        out.append(
            f'<line x1="{L}" y1="{y:.1f}" x2="{W - R}" y2="{y:.1f}" '
            f'stroke="var(--border)" stroke-width="1"/>'
        )
        out.append(
            f'<text x="{L - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="11" '
            f'fill="var(--text-dim)">{e:.0f}</text>'
        )

    # X ticks every 5 generations plus both endpoints, dropping any regular tick
    # that would sit on top of the final one.
    ticks = {x_min, x_max} | {g for g in range(5, x_max, 5) if x_max - g > 2}
    for g in sorted(ticks):
        out.append(
            f'<text x="{px(g):.1f}" y="{H - B + 16}" text-anchor="middle" font-size="11" '
            f'fill="var(--text-dim)">{g}</text>'
        )

    # Series lines, then a direct label at each line's right end.
    for _, label, colour, pts in data:
        d = " ".join(
            f"{'M' if i == 0 else 'L'}{px(g):.1f} {py(e):.1f}" for i, (g, e) in enumerate(pts)
        )
        out.append(f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="2" '
                   f'stroke-linejoin="round" stroke-linecap="round"/>')
        last_g, last_e = pts[-1]
        out.append(f'<circle cx="{px(last_g):.1f}" cy="{py(last_e):.1f}" r="4" fill="{colour}"/>')
        out.append(
            f'<text x="{px(last_g) + 10:.1f}" y="{py(last_e) + 4:.1f}" font-size="12" '
            f'fill="var(--text-secondary)">{label} {last_e:.0f}</text>'
        )

    # No legend box: every series is directly labelled at its right-hand end, so
    # identity is already carried by something other than colour.
    out.append(
        f'<text x="{L}" y="20" font-size="14" font-weight="600" fill="var(--text-primary)">'
        f"{args.variant.capitalize()} 8x8 (policy only, no search)</text>"
    )
    out.append(
        f'<text x="{L - 8}" y="{T - 14}" text-anchor="end" font-size="11" '
        f'fill="var(--text-dim)">Elo</text>'
    )
    out.append(
        f'<text x="{(L + W - R) / 2:.0f}" y="{H - 4}" text-anchor="middle" font-size="11" '
        f'fill="var(--text-dim)">generation</text>'
    )
    out.append("</svg>")
    print("".join(out))


if __name__ == "__main__":
    main()
