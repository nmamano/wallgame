/**
 * A real finished Standard game (wallgame.io game Lndfn42U, 2026-10-23; P2
 * wins by capture on the last of 28 plies), as the database stores it. Games
 * are public; this one is in a daily video (item v-2026-11-20-1).
 */

import type { StoredGame } from "../../shared/domain/game-position-puzzle";
import type { StandardInitialState } from "../../shared/domain/game-types";

export const STORED_GAME_ID = "Lndfn42U";

export const STORED_INITIAL_STATE: StandardInitialState = {
  pawns: {
    p1: { cat: [0, 1], mouse: [5, 1] },
    p2: { cat: [0, 6], mouse: [5, 6] },
  },
  walls: [
    { cell: [2, 1], orientation: "vertical" },
    { cell: [2, 5], orientation: "vertical" },
    { cell: [3, 2], orientation: "vertical" },
    { cell: [3, 4], orientation: "vertical" },
    { cell: [7, 2], orientation: "vertical" },
    { cell: [7, 4], orientation: "vertical" },
  ],
};

export const STORED_MOVES = [
  "Cc7",
  "^e4.^f5",
  "^g6.^h6",
  "Cf8.^c6",
  "Cd6",
  ">c6.^d4",
  "Cc7",
  "Cd8",
  "Cb6",
  "Cb8",
  "Cb4",
  "Cb6",
  "Cd4",
  "Cb4",
  "^a3.^b3",
  "Cc3",
  ">b3.^c2",
  "Cd2",
  ">b2.^d1",
  "Cc1",
  "Cf4",
  ">f4.^f3",
  "^b1.Ce4",
  "Ca1",
  "Cf3",
  ">f3.Ca2",
  "^b2.Cf2",
  "Cb3",
];

export const STORED_GAME: StoredGame = {
  config: {
    variant: "standard",
    randomStart: false,
    timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
    rated: false,
    boardWidth: 8,
    boardHeight: 8,
    variantConfig: STORED_INITIAL_STATE,
  },
  moves: STORED_MOVES,
};
