#!/bin/bash
# Complete Universal Model ELO Tournament Script
# Runs tournament, calculates ELO with BayesElo, and generates plots
#
# Configuration: 18 tournaments × 10 games/matchup = 10,440 games per variant

set -e

#==============================================================================
# CONFIGURATION
#==============================================================================

MODELS_DIR="../models_12x10_universal"
OUTPUT_DIR="../tournament_results_universal"
THREADS=28
TOURNAMENTS=18
GAMES_PER_MATCHUP=10
COLUMNS=12
ROWS=10
SAMPLES=1200  # Match training configuration

# BayesElo location - will check multiple common locations
BAYESELO_PATHS=(
    "../../../BayesianElo/src/bayeselo"     # Sibling to wallgame repo (YOUR ACTUAL LOCATION)
    "../../bayeselo/src/bayeselo"           # Alternative lowercase naming
    "../../../bayeselo/src/bayeselo"        # Parent directory
    "$HOME/bayeselo/src/bayeselo"           # Home directory
    "/usr/local/bin/bayeselo"               # System install
    "bayeselo"                               # In PATH
)

#==============================================================================
# HELPER FUNCTIONS
#==============================================================================

find_bayeselo() {
    for path in "${BAYESELO_PATHS[@]}"; do
        if [ -f "$path" ] || command -v "$path" &> /dev/null; then
            echo "$path"
            return 0
        fi
    done
    return 1
}

print_bayeselo_help() {
    cat << 'EOF'

ERROR: BayesElo not found!

BayesElo is required to calculate ELO ratings from tournament results.

Installation options:

1. Install as sibling to wallgame repo (recommended):
   cd /mnt/c/Users/Nilo/repos
   git clone https://github.com/ddugovic/bayeselo.git
   cd bayeselo/src
   make

2. Install elsewhere and add to PATH:
   git clone https://github.com/ddugovic/bayeselo.git
   cd bayeselo/src
   make
   # Add to PATH or update BAYESELO_PATHS in this script

After installation, re-run this script.

EOF
}

#==============================================================================
# TOURNAMENT EXECUTION
#==============================================================================

run_variant_tournament() {
    local variant=$1
    local output_dir="$OUTPUT_DIR/$variant"

    echo "=========================================="
    echo "Starting $variant variant tournament"
    echo "Output: $output_dir"
    echo "Start time: $(date)"
    echo "=========================================="
    echo ""

    # Create output directory
    mkdir -p "$output_dir"

    # Run tournament
    cd build
    ./deep_ww --ranking "$MODELS_DIR" \
        --tournaments $TOURNAMENTS \
        --games $GAMES_PER_MATCHUP \
        --columns $COLUMNS \
        --rows $ROWS \
        --variant $variant \
        --samples $SAMPLES \
        -j $THREADS
    cd ..

    # Move results to variant-specific directory
    mv "$MODELS_DIR/games.pgn" "$output_dir/" 2>/dev/null || true
    mv "$MODELS_DIR/games.json" "$output_dir/" 2>/dev/null || true

    echo ""
    echo "=========================================="
    echo "$variant tournament complete!"
    echo "End time: $(date)"
    echo "=========================================="
    echo ""
}

#==============================================================================
# ELO CALCULATION
#==============================================================================

calculate_elo() {
    local variant=$1
    local pgn_file="$OUTPUT_DIR/$variant/games.pgn"
    local output_txt="$OUTPUT_DIR/$variant/elo_ratings.txt"
    local output_csv="$OUTPUT_DIR/$variant/elo_ratings.csv"

    if [ ! -f "$pgn_file" ]; then
        echo "ERROR: PGN file not found: $pgn_file"
        return 1
    fi

    echo "=========================================="
    echo "Calculating ELO for $variant variant"
    echo "=========================================="
    echo "Input: $pgn_file"
    echo ""

    # Create BayesElo command file (absolute path for PGN)
    local abs_pgn_path=$(cd "$(dirname "$pgn_file")" && pwd)/$(basename "$pgn_file")
    local abs_output_txt=$(cd "$(dirname "$output_txt")" && pwd)/$(basename "$output_txt")
    local abs_output_csv=$(cd "$(dirname "$output_csv")" && pwd)/$(basename "$output_csv")

    cat > /tmp/bayeselo_commands_$variant.txt << EOF
readpgn $abs_pgn_path
elo
mm
exactdist
ratings >$abs_output_txt
offset 1500
ratings >$abs_output_csv
x
EOF

    # Run BayesElo
    $BAYESELO_CMD < /tmp/bayeselo_commands_$variant.txt

    echo ""
    echo "Results saved:"
    echo "  Text: $output_txt"
    echo "  CSV:  $output_csv"
    echo ""

    # Display top 10 models
    if [ -f "$output_txt" ]; then
        echo "Top 10 models for $variant variant:"
        echo "----------------------------------------"
        head -13 "$output_txt" | tail -10
        echo "----------------------------------------"
        echo ""
    fi

    # Clean up
    rm /tmp/bayeselo_commands_$variant.txt
}

#==============================================================================
# PLOTTING
#==============================================================================

generate_plot() {
    local variant=$1
    local csv_file="$OUTPUT_DIR/$variant/elo_ratings.csv"
    local output_png="$OUTPUT_DIR/$variant/elo_progression.png"

    if [ ! -f "$csv_file" ]; then
        echo "WARNING: CSV file not found: $csv_file"
        return 1
    fi

    echo "Generating plot for $variant variant..."

    # Check if Python and required packages are available
    if ! command -v python3 &> /dev/null; then
        echo "WARNING: python3 not found, skipping plot generation"
        return 1
    fi

    # Run plotting script
    cd scripts
    python3 plot_elo.py "$csv_file" \
        --output "$output_png" \
        --games 4000 2>/dev/null || {
        echo "WARNING: Plot generation failed (missing dependencies?)"
        cd ..
        return 1
    }
    cd ..

    echo "Plot saved: $output_png"
    echo ""
}

#==============================================================================
# MAIN EXECUTION
#==============================================================================

echo "=========================================="
echo "Universal Model ELO Tournament"
echo "=========================================="
echo "Models: $(ls $MODELS_DIR/*.trt 2>/dev/null | wc -l) models"
echo "Tournaments: $TOURNAMENTS"
echo "Games per matchup: $GAMES_PER_MATCHUP"
echo "Estimated games per variant: $((TOURNAMENTS * 58 * GAMES_PER_MATCHUP))"
echo "Board size: ${COLUMNS}x${ROWS}"
echo "Threads: $THREADS"
echo "=========================================="
echo ""

# Validate model count
MODEL_COUNT=$(ls $MODELS_DIR/*.trt 2>/dev/null | wc -l)
if [ "$MODEL_COUNT" -ne 59 ]; then
    echo "WARNING: Expected 59 models, found $MODEL_COUNT"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Find BayesElo
BAYESELO_CMD=$(find_bayeselo)
if [ $? -ne 0 ]; then
    print_bayeselo_help
    exit 1
fi
echo "✓ BayesElo found: $BAYESELO_CMD"
echo ""

# Ask which variant(s) to run
echo "Which variant(s) do you want to run?"
echo "1) Standard only"
echo "2) Classic only"
echo "3) Both (recommended)"
read -p "Enter choice (1-3): " choice
echo ""

VARIANTS_TO_RUN=()
case $choice in
    1) VARIANTS_TO_RUN=("standard") ;;
    2) VARIANTS_TO_RUN=("classic") ;;
    3) VARIANTS_TO_RUN=("standard" "classic") ;;
    *)
        echo "Invalid choice. Exiting."
        exit 1
        ;;
esac

# Run tournaments for selected variants
for variant in "${VARIANTS_TO_RUN[@]}"; do
    run_variant_tournament "$variant"
done

echo ""
echo "=========================================="
echo "All tournaments complete!"
echo "Processing results with BayesElo..."
echo "=========================================="
echo ""

# Calculate ELO for each variant
for variant in "${VARIANTS_TO_RUN[@]}"; do
    calculate_elo "$variant"
done

echo ""
echo "=========================================="
echo "Generating plots..."
echo "=========================================="
echo ""

# Generate plots for each variant
for variant in "${VARIANTS_TO_RUN[@]}"; do
    generate_plot "$variant" || true  # Don't fail if plotting doesn't work
done

#==============================================================================
# SUMMARY
#==============================================================================

echo ""
echo "=========================================="
echo "TOURNAMENT COMPLETE!"
echo "=========================================="
echo ""
echo "Results:"
for variant in "${VARIANTS_TO_RUN[@]}"; do
    echo ""
    echo "$variant variant:"
    echo "  PGN:    $OUTPUT_DIR/$variant/games.pgn"
    echo "  JSON:   $OUTPUT_DIR/$variant/games.json"
    echo "  ELO:    $OUTPUT_DIR/$variant/elo_ratings.txt"
    echo "  CSV:    $OUTPUT_DIR/$variant/elo_ratings.csv"
    if [ -f "$OUTPUT_DIR/$variant/elo_progression.png" ]; then
        echo "  Plot:   $OUTPUT_DIR/$variant/elo_progression.png"
    fi
done

echo ""
echo "Next steps:"
echo "1. Review ELO ratings in elo_ratings.txt files"
echo "2. View plots (if generated)"
echo "3. Compare Standard vs Classic rankings"
echo "4. Identify best model for deployment"
echo ""
echo "See UNIVERSAL_TOURNAMENT_PLAN.md for analysis guidance"
echo "=========================================="
