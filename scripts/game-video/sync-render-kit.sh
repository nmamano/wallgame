#!/usr/bin/env bash
# Copy the game-video renderer to the 4090 render box (board task e8d26610).
#
# Nil, 2026-10-25: all video renders run on the 4090. The box keeps a small
# render kit, not a checkout: the renderer, the stage, the sounds it mixes,
# and playwright-core with its Chromium. The kit mirrors the repo's paths, so
# the renderer finds its assets exactly as it does in a checkout.
#
#   scripts/game-video/sync-render-kit.sh <ssh target of the 4090's WSL>
#
# The target is an argument because this repository is public; it is in
# ops-private/wallgamer-agent-notes.md.
#
# Run it after every change to the renderer or the sounds. It sets up a fresh
# box too: it installs playwright-core and Chromium when they are missing. The
# box runs Node 18 and Playwright needs 20, so everything there runs on bun.
#
# The wallz caption needs two fonts in the box's user font folder: TikTok Sans
# and Noto Color Emoji, both OFL, from github.com/google/fonts. This script
# does not fetch fonts; it stops if they are missing.
set -euo pipefail

host="${1:?usage: sync-render-kit.sh <ssh target of the 4090 WSL>}"
kit="nil/wallgame-video"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"

test -d assets/meme-sounds || {
  echo "assets/meme-sounds/ is missing here; see scripts/game-video/meme-sounds.md" >&2
  exit 1
}
test -f assets/stings/vs-b-riser.wav || bun scripts/game-video/make-stings.mjs

rsync -a --relative \
  scripts/game-video/render-game-video.mjs \
  scripts/game-video/stage.html \
  scripts/game-video/capture-replay-frames.mjs \
  scripts/game-video/capture-feedback.mjs \
  scripts/game-video/verify-encoded-video.mjs \
  scripts/game-video/timeline-frames.mjs \
  scripts/game-video/make-stings.mjs \
  scripts/game-video/edl.mjs \
  scripts/game-video/meme-sounds.mjs \
  scripts/game-video/music-tracks.mjs \
  frontend/public/audio/pawn.wav \
  frontend/public/audio/wall.wav \
  frontend/public/audio/game_start.mp3 \
  frontend/public/audio/game_end.mp3 \
  frontend/public/audio/songs \
  assets/audio/pixel_game_essentials \
  assets/stings \
  assets/meme-sounds \
  "$host:$kit/"

playwright="$(bun -e 'console.log(require("playwright-core/package.json").version)')"
ssh "$host" bash -s -- "$kit" "$playwright" <<'REMOTE'
set -euo pipefail
kit="$HOME/$1"; version="$2"; bun="$HOME/.bun/bin/bun"
cd "$kit"
test -f package.json || echo '{"name":"wallgame-video-kit","private":true,"type":"module"}' > package.json
have="$("$bun" -e 'try{console.log(require("playwright-core/package.json").version)}catch{}')"
if [ "$have" != "$version" ]; then
  "$bun" add "playwright-core@$version" > /dev/null 2>&1
  "$bun" node_modules/playwright-core/cli.js install chromium > /dev/null 2>&1
fi
fc-list : family | grep -q "TikTok Sans" || { echo "font TikTok Sans missing on the render box" >&2; exit 1; }
fc-list : family | grep -q "Noto Color Emoji" || { echo "font Noto Color Emoji missing on the render box" >&2; exit 1; }
echo "render kit ready: $kit, playwright-core $version"
REMOTE
