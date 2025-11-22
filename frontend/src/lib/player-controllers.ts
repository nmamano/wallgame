import type { PlayerType } from "@/components/player-configuration";
import { getAiMove, Move, type PlayerId } from "./game";
import type { GameState } from "./game-state";

export type PlayerControllerKind = "local-human" | "easy-bot" | "unsupported";

export interface PlayerControllerContext {
  state: GameState;
  playerId: PlayerId;
  opponentId: PlayerId;
}

interface BasePlayerController {
  playerId: PlayerId;
  playerType: PlayerType;
  kind: PlayerControllerKind;
  makeMove(context: PlayerControllerContext): Promise<Move>;
  cancel?(reason?: unknown): void;
}

export interface LocalPlayerController extends BasePlayerController {
  kind: "local-human";
  submitMove(move: Move): void;
  hasPendingMove(): boolean;
}

export interface AutomatedPlayerController extends BasePlayerController {
  kind: "easy-bot";
}

export interface UnsupportedPlayerController extends BasePlayerController {
  kind: "unsupported";
}

export type GamePlayerController =
  | LocalPlayerController
  | AutomatedPlayerController
  | UnsupportedPlayerController;

export function createPlayerController(args: {
  playerId: PlayerId;
  playerType: PlayerType;
}): GamePlayerController {
  const { playerId, playerType } = args;
  switch (playerType) {
    case "you":
      return new LocalHumanController(playerId, playerType);
    case "easy-bot":
      return new EasyBotController(playerId, playerType);
    default:
      return new UnsupportedController(playerId, playerType);
  }
}

export function isLocalController(
  controller: GamePlayerController
): controller is LocalPlayerController {
  return controller.kind === "local-human";
}

export function isAutomatedController(
  controller: GamePlayerController
): controller is AutomatedPlayerController {
  return controller.kind === "easy-bot";
}

export function isSupportedController(
  controller: GamePlayerController
): controller is LocalPlayerController | AutomatedPlayerController {
  return controller.kind !== "unsupported";
}

class LocalHumanController implements LocalPlayerController {
  kind = "local-human" as const;
  private pendingMove: {
    resolve: (move: Move) => void;
    reject: (reason?: unknown) => void;
  } | null = null;

  constructor(
    public playerId: PlayerId,
    public playerType: PlayerType
  ) {}

  async makeMove(): Promise<Move> {
    if (this.pendingMove) {
      this.pendingMove.reject(
        new Error("Previous move request was still pending.")
      );
      this.pendingMove = null;
    }

    return new Promise<Move>((resolve, reject) => {
      this.pendingMove = { resolve, reject };
    });
  }

  submitMove(move: Move): void {
    if (!this.pendingMove) {
      throw new Error("No pending move request for this player.");
    }
    this.pendingMove.resolve(move);
    this.pendingMove = null;
  }

  hasPendingMove(): boolean {
    return this.pendingMove !== null;
  }

  cancel(reason?: unknown): void {
    if (this.pendingMove) {
      this.pendingMove.reject(
        reason ?? new Error("Move request cancelled by system.")
      );
      this.pendingMove = null;
    }
  }
}

class EasyBotController implements AutomatedPlayerController {
  kind = "easy-bot" as const;

  constructor(
    public playerId: PlayerId,
    public playerType: PlayerType
  ) {}

  async makeMove({
    state,
    playerId,
    opponentId,
  }: PlayerControllerContext): Promise<Move> {
    const aiCatPos: [number, number] = [
      state.pawns[playerId].cat.row,
      state.pawns[playerId].cat.col,
    ];
    const opponentMousePos: [number, number] = [
      state.pawns[opponentId].mouse.row,
      state.pawns[opponentId].mouse.col,
    ];

    await delay(600);
    return getAiMove(state.grid.clone(), aiCatPos, opponentMousePos);
  }

  cancel(): void {
    // Nothing to cancel for deterministic bots right now.
  }
}

class UnsupportedController implements UnsupportedPlayerController {
  kind = "unsupported" as const;

  constructor(
    public playerId: PlayerId,
    public playerType: PlayerType
  ) {}

  async makeMove(): Promise<Move> {
    return Promise.reject(
      new Error(`Player type "${this.playerType}" is not supported yet.`)
    );
  }

  cancel(): void {
    // Nothing to cancel.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

