#!/bin/bash

# Ralph Wiggum - Autonomous Agent Loop for V3 Migration
# Usage: ./ralph.sh <max_iterations>
#
# Each iteration runs in a fresh context window, preventing context bloat
# and hallucination issues that occur with single-context approaches.

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations>"
  echo "Example: $0 20"
  exit 1
fi

MAX_ITERATIONS=$1
COMPLETION_MARKER="<promise>COMPLETE</promise>"

echo "=============================================="
echo "  Ralph Wiggum - V3 Migration Loop"
echo "  Max iterations: $MAX_ITERATIONS"
echo "=============================================="
echo ""

for ((i=1; i<=$MAX_ITERATIONS; i++)); do
  echo "=============================================="
  echo "  Iteration $i of $MAX_ITERATIONS"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================================="
  echo ""

  # Run Claude with the prompt file, capturing output
  # The || true prevents the script from exiting if claude returns non-zero
  result=$(claude -p "$(cat PROMPT.md)" --output-format text 2>&1) || true

  echo "$result"
  echo ""

  # Check for completion marker
  if [[ "$result" == *"$COMPLETION_MARKER"* ]]; then
    echo "=============================================="
    echo "  SUCCESS: All tasks complete!"
    echo "  Finished after $i iterations"
    echo "  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "=============================================="
    exit 0
  fi

  echo "--- End of iteration $i ---"
  echo ""
done

echo "=============================================="
echo "  STOPPED: Reached max iterations ($MAX_ITERATIONS)"
echo "  Check activity.md for progress"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="
exit 1
