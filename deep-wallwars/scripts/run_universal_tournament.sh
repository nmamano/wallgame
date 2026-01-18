#!/bin/bash
# Universal Model ELO Tournament Script
# Tests all 59 models (model_0 through model_58) on both Standard and Classic variants
#
# Configuration: 18 tournaments × 10 games/matchup = 10,440 games per variant

set -e

MODELS_DIR="../models_12x10_universal"
OUTPUT_DIR="../tournament_results_universal"
THREADS=28
TOURNAMENTS=18
GAMES_PER_MATCHUP=10
COLUMNS=12
ROWS=10
SAMPLES=1200  # Match training configuration

# Create output directories
mkdir -p "$OUTPUT_DIR/standard"
mkdir -p "$OUTPUT_DIR/classic"

echo "=========================================="
echo "Universal Model ELO Tournament"
echo "=========================================="
echo "Models: $(ls $MODELS_DIR/*.trt | wc -l) models"
echo "Tournaments: $TOURNAMENTS"
echo "Games per matchup: $GAMES_PER_MATCHUP"
echo "Estimated games per variant: $((TOURNAMENTS * 58 * GAMES_PER_MATCHUP))"
echo "Board size: ${COLUMNS}x${ROWS}"
echo "Threads: $THREADS"
echo "=========================================="
echo ""

# Model count validation
MODEL_COUNT=$(ls $MODELS_DIR/*.trt | wc -l)
if [ "$MODEL_COUNT" -ne 59 ]; then
    echo "WARNING: Expected 59 models, found $MODEL_COUNT"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Function to run tournament for a variant
run_variant_tournament() {
    local variant=$1
    local output_dir="$OUTPUT_DIR/$variant"

    echo "=========================================="
    echo "Starting $variant variant tournament"
    echo "Output: $output_dir"
    echo "Start time: $(date)"
    echo "=========================================="

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
    mv "$MODELS_DIR/games.pgn" "$output_dir/"
    mv "$MODELS_DIR/games.json" "$output_dir/"

    echo "=========================================="
    echo "$variant tournament complete!"
    echo "End time: $(date)"
    echo "Results saved to: $output_dir"
    echo "=========================================="
    echo ""
}

# Ask user which variant(s) to run
echo "Which variant(s) do you want to run?"
echo "1) Standard only"
echo "2) Classic only"
echo "3) Both (recommended)"
read -p "Enter choice (1-3): " choice

case $choice in
    1)
        run_variant_tournament "standard"
        ;;
    2)
        run_variant_tournament "classic"
        ;;
    3)
        run_variant_tournament "standard"
        echo ""
        echo "=========================================="
        echo "Standard complete. Starting Classic..."
        echo "=========================================="
        echo ""
        sleep 2
        run_variant_tournament "classic"
        ;;
    *)
        echo "Invalid choice. Exiting."
        exit 1
        ;;
esac

echo "=========================================="
echo "ALL TOURNAMENTS COMPLETE!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Calculate ELO ratings with BayesElo:"
echo "   cd scripts"
echo "   ./calculate_elo.sh"
echo ""
echo "2. Or manually with BayesElo:"
echo "   readpgn $OUTPUT_DIR/standard/games.pgn"
echo "   elo"
echo "   mm"
echo "   exactdist"
echo "   ratings"
echo ""
echo "Results locations:"
echo "  Standard: $OUTPUT_DIR/standard/games.pgn"
echo "  Classic:  $OUTPUT_DIR/classic/games.pgn"
echo "=========================================="
