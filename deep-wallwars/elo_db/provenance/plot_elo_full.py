import re, math, json, glob, sys
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from collections import defaultdict

variant = sys.argv[1]  # classic | standard
REF = "** HARD BOT **" if variant == "classic" else "** MEDIUM BOT **"
REF_LABEL = "ResNet (750k self-play games)" if variant == "classic" else "ResNet (~ human level)"
ANCHOR = 926 if variant == "classic" else 336

wins = defaultdict(float); games = defaultdict(lambda: defaultdict(int))
def add(a, b, ra):
    games[a][b] += 1; games[b][a] += 1
    if ra == 1: wins[a] += 1
    elif ra == 0: wins[b] += 1
    else: wins[a] += 0.5; wins[b] += 0.5

pat = re.compile(r'\[White "([^"]+)"\]\[Black "([^"]+)"\]\[Result "([^"]+)"\]')
pgns = [f"/home/nilo/elo_tournament/games_full_{variant}.pgn"] + \
       sorted(glob.glob(f"/home/nilo/elo_tournament/ext_{variant}/pair_*.pgn"))
ng = 0
for path in pgns:
    for line in open(path):
        m = pat.search(line)
        if not m: continue
        w, b, r = m.groups(); ng += 1
        add(w, b, 1 if r == "1-0" else 0 if r == "0-1" else 0.5)

sr = json.load(open("/home/nilo/super_results.json")); na = 0
for rec in sr["results"]:
    v = rec.get(variant)
    if not v: continue
    t = f"model_{rec['gen']}.trt"
    for _ in range(v["w"]): add(t, REF, 1); na += 1
    for _ in range(v["l"]): add(t, REF, 0); na += 1
    for _ in range(v["d"]): add(t, REF, 0.5); na += 1

models = list(games.keys())
gamma = {m: 1.0 for m in models}
for _ in range(3000):
    new = {}
    for i in models:
        d = sum(games[i][j] / (gamma[i] + gamma[j]) for j in models if games[i][j] and gamma[i] + gamma[j] > 0)
        new[i] = wins[i] / d if d > 0 else gamma[i]
    lm = sum(math.log(new[m]) for m in models) / len(models)
    g = math.exp(lm)
    gamma = {m: new[m] / g for m in models}
elo = {m: 400 * math.log10(gamma[m]) for m in models}
off = ANCHOR - elo[REF]
elo = {m: e + off for m, e in elo.items()}

pts = sorted((int(m.group(1)), elo[k]) for k in models
             if (m := re.fullmatch(r"model_(\d+)\.trt", k)))
xs = [p[0] for p in pts]; ys = [p[1] for p in pts]

plt.figure(figsize=(11, 6))
plt.plot(xs, ys, "-o", ms=3.5, lw=1.4, color="#3b7dd8", label="transformer")
plt.axhline(ANCHOR, color="#d84a3b", ls="--", lw=1.5, label=f"{REF_LABEL} = {ANCHOR}")
plt.axvline(36.5, color="#999", ls=":", lw=1)
plt.text(36.6, min(ys) + 20, "sizes up to\n9x9", fontsize=8, color="#666")
plt.axvline(44.5, color="#b8860b", ls=":", lw=1)
plt.text(44.6, min(ys) + 20, "sizes up to\n10x10", fontsize=8, color="#997700")
plt.axvline(57.5, color="#2a8b57", ls=":", lw=1)
plt.text(57.6, min(ys) + 20, "sizes up to\n10x12", fontsize=8, color="#1f7a4d")
plt.title(f"{variant.capitalize()} Elo (8x8 board)")
plt.xlabel("Generation (2.5k classic + 2.5k standard self-play games each, on a mix of board sizes)"); plt.ylabel("Elo")
plt.grid(alpha=0.3); plt.legend()
plt.tight_layout()
plt.savefig(f"/home/nilo/elo_tournament/elo_plot_{variant}_full.png", dpi=130)

peak_gen, peak = max(pts, key=lambda p: p[1])
print(f"[{variant}] last gens:", " ".join(f"{x}:{y:.0f}" for x, y in pts[-8:]))
print(f"[{variant}] peak: gen {peak_gen} at {peak:.0f}; last two within {max(peak - ys[-1], peak - ys[-2]):.0f} of peak")
