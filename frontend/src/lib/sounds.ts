import { assetUrl } from "@/lib/asset-url";

/**
 * The game's sounds, made only when a game first plays one (task 42c3ae3a).
 *
 * The game code also loads in idle time on pages that start a game
 * (main.tsx), so a sound made when this module loads would download on a page
 * that may never play it. The first `play()` makes every sound at once, so the
 * move sounds load during the game's opening sound, before the first move.
 *
 * The click sounds are mp3 copies of the .wav files next to them in
 * public/audio, a fifth of the size. The .wav files stay: the game-video
 * renderer reads them from disk and depends on their exact timing
 * (scripts/game-video/render-game-video.mjs), and it copies these volumes.
 */
const SOUNDS = {
  pawn: { url: assetUrl("/audio/pawn.mp3"), volume: 0.9 },
  pawnUndo: { url: assetUrl("/audio/pawn_undo.mp3"), volume: 0.1 },
  wall: { url: assetUrl("/audio/wall.mp3"), volume: 0.5 },
  wallUndo: { url: assetUrl("/audio/wall_undo.mp3"), volume: 0.4 },
  gameStart: { url: assetUrl("/audio/game_start.mp3"), volume: 0.7 },
  gameEnd: { url: assetUrl("/audio/game_end.mp3"), volume: 0.7 },
} as const;

export type SoundName = keyof typeof SOUNDS;

let loaded: Record<SoundName, HTMLAudioElement> | null = null;

function loadSounds(): Record<SoundName, HTMLAudioElement> {
  const entries = Object.entries(SOUNDS).map(([name, { url, volume }]) => {
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.volume = volume;
    return [name, audio] as const;
  });
  return Object.fromEntries(entries) as Record<SoundName, HTMLAudioElement>;
}

export function play(name: SoundName) {
  loaded ??= loadSounds();
  const audio = loaded[name];
  audio.currentTime = 0;
  void audio.play();
}
