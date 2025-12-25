export const sounds = {
  pawn: new Audio("/audio/pawn.wav"),
  pawnUndo: new Audio("/audio/pawn_undo.wav"),
  wall: new Audio("/audio/wall.wav"),
  wallUndo: new Audio("/audio/wall_undo.wav"),
};

Object.values(sounds).forEach((a) => {
  a.preload = "auto";
});

sounds.pawn.volume = 0.9;
sounds.pawnUndo.volume = 0.1;
sounds.wall.volume = 0.5;
sounds.wallUndo.volume = 0.4;

export function play(a: HTMLAudioElement) {
  a.currentTime = 0;
  void a.play();
}
