#!/bin/bash
# Phase 7 (2026-08-04): resume the p4b/p6 mix after the 2026-07-24 pause.
# Identical mix/hyperparams to launch_curriculum_p6.sh; only the generation
# count and log paths change. Loop is range(start, start+G-1), so G=11 => 10
# new models on top of the latest (83).
cd ~/nil/wallgame/deep-wallwars/scripts
export PATH=/usr/src/tensorrt/bin:/usr/lib/wsl/lib:$HOME/.local/bin:$PATH
../.venv/bin/python training.py --arch transformer --d-model 256 --layers 10 --heads 8 \
  --columns 12 --rows 10 --variant universal \
  --size-mix 8x8=20,9x9=10,8x9=5,9x8=5,9x10=5,10x9=5,10x10=20,11x10=5,12x10=25 \
  --generations 11 --max-training-window 12 --initial_generation latest --games 5000 --samples 1000 \
  --training-batch-size 512 --inference-batch-size 256 --threads 22 \
  --deep_ww ../build-tests/deep_ww --models ../models_12x10_tf_curriculum \
  --data ../data_12x10_tf_curriculum --log ../logs_curriculum_deepww_p7.txt 2>&1 \
  | tee ../training_curriculum_p7.log
