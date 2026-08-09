import { assetUrl } from "@/lib/asset-url";

export const sounds = {
  pawn: new Audio(assetUrl("/audio/pawn.wav")),
  pawnUndo: new Audio(assetUrl("/audio/pawn_undo.wav")),
  wall: new Audio(assetUrl("/audio/wall.wav")),
  wallUndo: new Audio(assetUrl("/audio/wall_undo.wav")),
  gameStart: new Audio(assetUrl("/audio/game_start.mp3")),
  gameEnd: new Audio(assetUrl("/audio/game_end.mp3")),
};

Object.values(sounds).forEach((a) => {
  a.preload = "auto";
});

sounds.pawn.volume = 0.9;
sounds.pawnUndo.volume = 0.1;
sounds.wall.volume = 0.5;
sounds.wallUndo.volume = 0.4;
sounds.gameStart.volume = 0.7;
sounds.gameEnd.volume = 0.7;

export function play(a: HTMLAudioElement) {
  a.currentTime = 0;
  void a.play();
}
