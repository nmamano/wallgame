import type { PlayerType } from "@/lib/gameViewModel";
import type { PlayerId, Move } from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import type {
  ControllerActionKind,
  RematchDecision,
} from "../../../shared/contracts/controller-actions";
export type {
  ControllerActionKind,
  RematchDecision,
} from "../../../shared/contracts/controller-actions";

export type ActionChannel = "local-state" | "remote-controller";

export type PlayerControllerKind =
  | "local-human"
  | "remote-human"
  | "unsupported";

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

export interface ControllerCapabilities {
  canMove: boolean;
  canOfferDraw: boolean;
  canRespondToDraw: boolean;
  canRequestTakeback: boolean;
  canRespondToTakeback: boolean;
  canOfferRematch: boolean;
  canUseChat: boolean;
}

export interface MetaActionPayloadMap {
  resign: void;
  offerDraw: void;
  requestTakeback: void;
  giveTime: { seconds: number };
}

export type MetaActionKind = keyof MetaActionPayloadMap;

export type MetaActionPayload<K extends MetaActionKind> =
  MetaActionPayloadMap[K];

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface ControllerErrorBase {
  message?: string;
  cause?: unknown;
}

export type ControllerError =
  | ({
      kind: "ControllerUnavailable";
      action?: ControllerActionKind;
    } & ControllerErrorBase)
  | ({
      kind: "NotCapable";
      action: ControllerActionKind;
    } & ControllerErrorBase)
  | ({
      kind: "TransientTransport";
      action?: ControllerActionKind;
    } & ControllerErrorBase)
  | ({
      kind: "ActionRejected";
      action: ControllerActionKind;
      code?: string;
    } & ControllerErrorBase)
  | ({
      kind: "UnsupportedAction";
      action: ControllerActionKind;
    } & ControllerErrorBase)
  | ({
      kind: "Unknown";
      action?: ControllerActionKind;
    } & ControllerErrorBase);

export type ControllerResult<T = void> = Result<T, ControllerError>;

export function controllerOk<T = void>(value: T): ControllerResult<T> {
  return { ok: true, value };
}

export function controllerError(
  error: ControllerError,
): ControllerResult<never> {
  return { ok: false, error };
}

interface BasePlayerController {
  playerId: PlayerId;
  playerType: PlayerType;
  kind: PlayerControllerKind;
  actionChannel: ActionChannel;
  capabilities: ControllerCapabilities;
  makeMove(context: PlayerControllerContext): Promise<Move>;
  respondToDrawOffer(context: DrawOfferContext): Promise<DrawDecision>;
  respondToTakebackRequest(
    context: TakebackRequestContext,
  ): Promise<TakebackDecision>;
  performVoluntaryAction?<K extends MetaActionKind>(
    action: K,
    payload: MetaActionPayload<K>,
  ): Promise<ControllerResult<void>>;
  resign?(): Promise<ControllerResult<void>>;
  offerDraw?(): Promise<ControllerResult<void>>;
  respondToRemoteDraw?(decision: DrawDecision): Promise<void>;
  requestTakeback?(): Promise<ControllerResult<void>>;
  respondToRemoteTakeback?(decision: TakebackDecision): Promise<void>;
  giveTime?(seconds: number): Promise<ControllerResult<void>>;
  offerRematch?(): Promise<ControllerResult<void>>;
  respondToRematch?(decision: RematchDecision): Promise<ControllerResult<void>>;
  handleStateUpdate?(context: PlayerControllerContext): void;
  cancel?(reason?: unknown): void;
}

export interface ManualPlayerController extends BasePlayerController {
  submitMove(move: Move): void;
  hasPendingMove(): boolean;
  submitDrawDecision(decision: DrawDecision): void;
  submitTakebackDecision(decision: TakebackDecision): void;
}

export interface LocalPlayerController extends ManualPlayerController {
  kind: "local-human";
}

export interface RemoteHumanController extends ManualPlayerController {
  kind: "remote-human";
  connect?(handlers: unknown): void;
  disconnect?(): void;
  isConnected(): boolean;
}

export interface UnsupportedPlayerController extends BasePlayerController {
  kind: "unsupported";
}

export type GamePlayerController =
  | LocalPlayerController
  | RemoteHumanController
  | UnsupportedPlayerController;

export function createPlayerController(args: {
  playerId: PlayerId;
  playerType: PlayerType;
}): GamePlayerController {
  const { playerId, playerType } = args;
  switch (playerType) {
    case "you":
      return new LocalHumanController(playerId, playerType);
    default:
      return new UnsupportedController(playerId, playerType);
  }
}

export function isLocalController(
  controller: GamePlayerController,
): controller is LocalPlayerController | RemoteHumanController {
  return (
    controller.kind === "local-human" || controller.kind === "remote-human"
  );
}

export function isSupportedController(
  controller: GamePlayerController,
): controller is LocalPlayerController | RemoteHumanController {
  return controller.kind !== "unsupported";
}

export function isRemoteController(
  controller: GamePlayerController,
): controller is RemoteHumanController {
  return controller.kind === "remote-human";
}

export class LocalHumanController implements LocalPlayerController {
  kind = "local-human" as const;
  actionChannel = "local-state" as const;
  readonly capabilities = getCapabilitiesForType("you");
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
    public playerType: PlayerType,
  ) {}

  async makeMove(): Promise<Move> {
    if (this.pendingMove) {
      this.pendingMove.reject(
        new Error("Previous move request was still pending."),
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
        new Error("Previous draw request was still pending."),
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
        new Error("Previous takeback request was still pending."),
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
        reason ?? new Error("Move request cancelled by system."),
      );
      this.pendingMove = null;
    }
    if (this.pendingDrawDecision) {
      this.pendingDrawDecision.reject(
        reason ?? new Error("Draw request cancelled by system."),
      );
      this.pendingDrawDecision = null;
    }
    if (this.pendingTakebackDecision) {
      this.pendingTakebackDecision.reject(
        reason ?? new Error("Takeback request cancelled by system."),
      );
      this.pendingTakebackDecision = null;
    }
  }

  performVoluntaryAction(): never {
    throw new Error(
      "LocalHumanController cannot perform voluntary actions directly.",
    );
  }
}

class UnsupportedController implements UnsupportedPlayerController {
  kind = "unsupported" as const;
  actionChannel = "local-state" as const;
  readonly capabilities = getCapabilitiesForType("friend");

  constructor(
    public playerId: PlayerId,
    public playerType: PlayerType,
  ) {}

  async makeMove(): Promise<Move> {
    return Promise.reject(
      new Error(`Player type "${this.playerType}" is not supported yet.`),
    );
  }

  async respondToDrawOffer(): Promise<DrawDecision> {
    return Promise.reject(
      new Error(`Player type "${this.playerType}" cannot answer draw offers.`),
    );
  }

  async respondToTakebackRequest(): Promise<TakebackDecision> {
    return Promise.reject(
      new Error(
        `Player type "${this.playerType}" cannot answer takeback requests.`,
      ),
    );
  }

  cancel(): void {
    // Nothing to cancel.
  }

  performVoluntaryAction(): never {
    throw new Error("Unsupported controller cannot perform voluntary actions.");
  }
}

const BASE_CAPABILITIES: ControllerCapabilities = {
  canMove: false,
  canOfferDraw: false,
  canRespondToDraw: false,
  canRequestTakeback: false,
  canRespondToTakeback: false,
  canOfferRematch: false,
  canUseChat: false,
};

const CAPABILITIES_BY_TYPE: Record<PlayerType, ControllerCapabilities> = {
  you: {
    canMove: true,
    canOfferDraw: true,
    canRespondToDraw: true,
    canRequestTakeback: true,
    canRespondToTakeback: true,
    canOfferRematch: true,
    canUseChat: true,
  },
  friend: BASE_CAPABILITIES,
  "matched-user": BASE_CAPABILITIES,
  "custom-bot": BASE_CAPABILITIES,
};

export function getCapabilitiesForType(
  playerType: PlayerType,
): ControllerCapabilities {
  return { ...CAPABILITIES_BY_TYPE[playerType] };
}
