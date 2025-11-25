import type { PlayerType } from "@/components/player-configuration";
import { getAiMove } from "./dumb-ai";
import type { PlayerId, Move } from "../../../shared/game-types";
import type { GameState } from "../../../shared/game-state";

export type PlayerControllerKind = "local-human" | "easy-bot" | "unsupported";

export type DrawDecision = "accept" | "reject";
export type TakebackDecision = "allow" | "decline";

export interface PlayerControllerContext {
  state: GameState;
  playerId: PlayerId;
  opponentId: PlayerId;
}

export interface DrawOfferContext extends PlayerControllerContext {
  offeredBy: PlayerId;
}

export interface TakebackRequestContext extends PlayerControllerContext {
  requestedBy: PlayerId;
}

interface BasePlayerController {
  playerId: PlayerId;
  playerType: PlayerType;
  kind: PlayerControllerKind;
  makeMove(context: PlayerControllerContext): Promise<Move>;
  respondToDrawOffer(context: DrawOfferContext): Promise<DrawDecision>;
  respondToTakebackRequest(
    context: TakebackRequestContext
  ): Promise<TakebackDecision>;
  cancel?(reason?: unknown): void;
}

export interface LocalPlayerController extends BasePlayerController {
  kind: "local-human";
  submitMove(move: Move): void;
  hasPendingMove(): boolean;
  submitDrawDecision(decision: DrawDecision): void;
  submitTakebackDecision(decision: TakebackDecision): void;
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
  private pendingDrawDecision: {
    resolve: (decision: DrawDecision) => void;
    reject: (reason?: unknown) => void;
  } | null = null;
  private pendingTakebackDecision: {
    resolve: (decision: TakebackDecision) => void;
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

  respondToDrawOffer(): Promise<DrawDecision> {
    if (this.pendingDrawDecision) {
      this.pendingDrawDecision.reject(
        new Error("Previous draw request was still pending.")
      );
    }
    return new Promise<DrawDecision>((resolve, reject) => {
      this.pendingDrawDecision = { resolve, reject };
    });
  }

  submitDrawDecision(decision: DrawDecision): void {
    if (!this.pendingDrawDecision) {
      throw new Error("No pending draw decision for this player.");
    }
    this.pendingDrawDecision.resolve(decision);
    this.pendingDrawDecision = null;
  }

  respondToTakebackRequest(): Promise<TakebackDecision> {
    if (this.pendingTakebackDecision) {
      this.pendingTakebackDecision.reject(
        new Error("Previous takeback request was still pending.")
      );
    }
    return new Promise<TakebackDecision>((resolve, reject) => {
      this.pendingTakebackDecision = { resolve, reject };
    });
  }

  submitTakebackDecision(decision: TakebackDecision): void {
    if (!this.pendingTakebackDecision) {
      throw new Error("No pending takeback decision for this player.");
    }
    this.pendingTakebackDecision.resolve(decision);
    this.pendingTakebackDecision = null;
  }

  cancel(reason?: unknown): void {
    if (this.pendingMove) {
      this.pendingMove.reject(
        reason ?? new Error("Move request cancelled by system.")
      );
      this.pendingMove = null;
    }
    if (this.pendingDrawDecision) {
      this.pendingDrawDecision.reject(
        reason ?? new Error("Draw request cancelled by system.")
      );
      this.pendingDrawDecision = null;
    }
    if (this.pendingTakebackDecision) {
      this.pendingTakebackDecision.reject(
        reason ?? new Error("Takeback request cancelled by system.")
      );
      this.pendingTakebackDecision = null;
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
      state.pawns[playerId].cat[0],
      state.pawns[playerId].cat[1],
    ];
    const opponentMousePos: [number, number] = [
      state.pawns[opponentId].mouse[0],
      state.pawns[opponentId].mouse[1],
    ];

    await delay(2000);
    return getAiMove(state.grid.clone(), aiCatPos, opponentMousePos);
  }

  async respondToDrawOffer(): Promise<DrawDecision> {
    await delay(4000);
    return "accept";
  }

  async respondToTakebackRequest(): Promise<TakebackDecision> {
    await delay(4000);
    return "allow";
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

  async respondToDrawOffer(): Promise<DrawDecision> {
    return Promise.reject(
      new Error(`Player type "${this.playerType}" cannot answer draw offers.`)
    );
  }

  async respondToTakebackRequest(): Promise<TakebackDecision> {
    return Promise.reject(
      new Error(
        `Player type "${this.playerType}" cannot answer takeback requests.`
      )
    );
  }

  cancel(): void {
    // Nothing to cancel.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
