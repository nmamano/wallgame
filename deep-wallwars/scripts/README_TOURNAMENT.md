# Tournament Scripts

Quick reference for running ELO tournaments.

## Main Script (Use This!)

**`run_full_tournament.sh`** - Complete automated tournament

Does everything in one go:
- Runs tournaments for selected variant(s)
- Calculates ELO ratings with BayesElo
- Generates progression plots
- Displays results

```bash
cd deep-wallwars/scripts
./run_full_tournament.sh
```

## Configuration

All settings are at the top of `run_full_tournament.sh`:

```bash
TOURNAMENTS=18              # Number of tournament rounds
GAMES_PER_MATCHUP=10       # Games per head-to-head matchup
COLUMNS=12                 # Board width
ROWS=10                    # Board height
SAMPLES=1200               # MCTS samples per move
THREADS=28                 # Parallel execution threads
```

**Total games per variant:** 18 tournaments × 58 matchups × 10 games = **10,440 games**

## BayesElo Setup

The script automatically searches for BayesElo in common locations:
- `../../bayeselo/src/bayeselo` (sibling to wallgame repo)
- `../../../bayeselo/src/bayeselo`
- `$HOME/bayeselo/src/bayeselo`
- System PATH

### First Time: Install BayesElo

Recommended installation (sibling to wallgame repo):

```bash
cd /mnt/c/Users/Nilo/repos
git clone https://github.com/ddugovic/bayeselo.git
cd bayeselo/src
make
```

## Output

All results go to `deep-wallwars/tournament_results_universal/`:

```
tournament_results_universal/
├── standard/
│   ├── games.pgn              # Tournament game records
│   ├── games.json             # Detailed JSON records
│   ├── elo_ratings.txt        # Human-readable rankings
│   ├── elo_ratings.csv        # Data for analysis
│   └── elo_progression.png    # Visual plot
└── classic/
    └── (same files)
```

## Methodology

This uses the **exact same method** as previous tournaments for comparability:

1. **Single-elimination bracket tournaments**
   - Models randomly shuffled each tournament
   - Winners advance, losers eliminated
   - 18 tournaments provide enough data despite sparse matchups

2. **BayesElo calculation**
   - Standard commands: `readpgn → elo → mm → exactdist → ratings`
   - Same as documented in `info/elo-tournament-instructions.md`

3. **Plotting**
   - Uses existing `plot_elo.py` script
   - X-axis: training games played
   - Y-axis: ELO rating

## Customization

Edit variables at the top of `run_full_tournament.sh`:

**Reduce total games:**
```bash
TOURNAMENTS=15              # 15 × 58 × 10 = 8,700 games
```

**More decisive matchups:**
```bash
TOURNAMENTS=12
GAMES_PER_MATCHUP=15       # 12 × 58 × 15 = 10,440 games
```

**Different MCTS strength:**
```bash
SAMPLES=800                # Faster but weaker
SAMPLES=2000               # Slower but stronger
```

## See Also

- `../UNIVERSAL_TOURNAMENT_PLAN.md` - Full tournament documentation
- `../../info/elo-tournament-instructions.md` - General ELO tournament guide
- `../../info/universal_model.md` - Universal model training details
