#!/bin/bash

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
  --samples 1200 \
  --threads 28 \
  --training-games 20000 \
  --initial_generation latest
