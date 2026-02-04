#!/bin/bash

# Lower memory version: 8 gen window, 24k games, 2k samples, 2 epochs

cd deep-wallwars/scripts
source ../.venv/bin/activate

python3 training.py \
  --columns 12 --rows 10 \
  --variant universal \
  --models ../models_12x10_universal \
  --data ../data_12x10_universal \
  --log ../logs/universal_12x10.log \
  --generations 200 \
  --games 4000 \
  --samples 2000 \
  --threads 26 \
  --training-games 24000 \
  --max-training-window 8 \
  --epochs 2 \
  --initial_generation latest
