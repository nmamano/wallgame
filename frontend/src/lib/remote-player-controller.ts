import { GameClient } from "@/lib/game-client";
import type {
  GameClientHandlers,
  ActionRequestOutcome,
} from "@/lib/game-client";
import {
  type ActionChannel,
  LocalHumanController,
  controllerError,
  controllerOk,
  getCapabilitiesForType,
  type ControllerActionKind,
  type ControllerCapabilities,
  type ControllerResult,
  type DrawDecision,
  type DrawOfferContext,
  type MetaActionKind,
  type MetaActionPayload,
  type PlayerControllerContext,
  type RemoteHumanController,
  type RematchDecision,
  type TakebackDecision,
  type TakebackRequestContext,
} from "@/lib/player-controllers";
import type { PlayerType } from "@/lib/gameViewModel";
import type { Move, PlayerId } from "../../../shared/domain/game-types";
import type { ActionRequestPayload } from "../../../shared/contracts/controller-actions";

export type RemoteControllerHandlers = GameClientHandlers;

const CONTROLLER_ACTION_DESCRIPTIONS: Record<ControllerActionKind, string> = {
  resign: "resign",
  offerDraw: "offer a draw",
  requestTakeback: "request a takeback",
  giveTime: "adjust the clocks",
  offerRematch: "offer a rematch",
  respondRematch: "respond to a rematch",
};

export class RemotePlayerController implements RemoteHumanController {
  public readonly kind = "remote-human" as const;
  public readonly actionChannel: ActionChannel = "remote-controller";
  public readonly capabilities: ControllerCapabilities;
  private client: GameClient | null = null;
  private readonly delegate: LocalHumanController;
  private connectionReady = false;
  private localDrawPromptPending = false;
  private localTakebackPromptPending = false;

  constructor(
    public readonly playerId: PlayerId,
    public readonly playerType: PlayerType,
    private readonly connection: { gameId: string; socketToken: string },
  ) {
    this.capabilities = getCapabilitiesForType("you");
    this.delegate = new LocalHumanController(playerId, "you");
  }

  connect(handlers: RemoteControllerHandlers): void {
    this.client = new GameClient({
      gameId: this.connection.gameId,
      socketToken: this.connection.socketToken,
    });
    this.client.connect(handlers);
    this.connectionReady = true;
  }

  disconnect(): void {
    this.client?.close("remote-controller disconnect");
    this.client = null;
    this.connectionReady = false;
  }

  isConnected(): boolean {
    return this.connectionReady && this.client !== null;
  }

  async makeMove(context: PlayerControllerContext): Promise<Move> {
    void context;
    return this.delegate.makeMove();
  }

  respondToDrawOffer(_context: DrawOfferContext): Promise<DrawDecision> {
    void _context;
    this.localDrawPromptPending = true;
    return this.delegate.respondToDrawOffer();
  }

  respondToTakebackRequest(
    _context: TakebackRequestContext,
  ): Promise<TakebackDecision> {
    void _context;
    this.localTakebackPromptPending = true;
    return this.delegate.respondToTakebackRequest();
  }

  submitMove(move: Move): void {
    const client = this.getClient();
    client.sendMove(move);
    this.delegate.submitMove(move);
  }

  hasPendingMove(): boolean {
    return this.delegate.hasPendingMove();
  }

  submitDrawDecision(decision: DrawDecision): void {
    if (this.localDrawPromptPending) {
      this.localDrawPromptPending = false;
      this.delegate.submitDrawDecision(decision);
      return;
    }
    const client = this.getClient();
    if (decision === "accept") {
      client.sendDrawAccept();
      return;
    }
    client.sendDrawReject();
  }

  submitTakebackDecision(decision: TakebackDecision): void {
    if (this.localTakebackPromptPending) {
      this.localTakebackPromptPending = false;
      this.delegate.submitTakebackDecision(decision);
      return;
    }
    const client = this.getClient();
    if (decision === "allow") {
      client.sendTakebackAccept();
      return;
    }
    client.sendTakebackReject();
  }

  handleStateUpdate(context: PlayerControllerContext): void {
    const delegateWithHandlers = this.delegate as LocalHumanController & {
      handleStateUpdate?(ctx: PlayerControllerContext): void;
    };
    delegateWithHandlers.handleStateUpdate?.(context);
  }

  cancel(reason?: unknown): void {
    const cancelableDelegate = this.delegate as LocalHumanController & {
      cancel?(value?: unknown): void;
    };
    cancelableDelegate.cancel?.(reason);
  }

  resign(): Promise<ControllerResult<void>> {
    return this.runClientAction("resign");
  }

  offerDraw(): Promise<ControllerResult<void>> {
    return this.runClientAction("offerDraw");
  }

  respondToRemoteDraw(decision: DrawDecision): Promise<void> {
    const client = this.getClient();
    if (decision === "accept") {
      client.sendDrawAccept();
      return Promise.resolve();
    }
    client.sendDrawReject();
    return Promise.resolve();
  }

  requestTakeback(): Promise<ControllerResult<void>> {
    return this.runClientAction("requestTakeback");
  }

  respondToRemoteTakeback(decision: TakebackDecision): Promise<void> {
    const client = this.getClient();
    if (decision === "allow") {
      client.sendTakebackAccept();
      return Promise.resolve();
    }
    client.sendTakebackReject();
    return Promise.resolve();
  }

  giveTime(seconds: number): Promise<ControllerResult<void>> {
    return this.runClientAction("giveTime", { seconds });
  }

  offerRematch(): Promise<ControllerResult<void>> {
    return this.runClientAction("offerRematch");
  }

  respondToRematch(decision: RematchDecision): Promise<ControllerResult<void>> {
    return this.runClientAction("respondRematch", { decision });
  }

  performVoluntaryAction<K extends MetaActionKind>(
    action: K,
    payload: MetaActionPayload<K>,
  ): Promise<ControllerResult<void>> {
    switch (action) {
      case "resign": {
        return this.resign();
      }
      case "offerDraw": {
        return this.offerDraw();
      }
      case "requestTakeback": {
        return this.requestTakeback();
      }
      case "giveTime": {
        const seconds =
          (payload as MetaActionPayload<"giveTime"> | undefined)?.seconds ?? 0;
        return this.giveTime(seconds);
      }
      default: {
        const exhaustiveCheck: never = action;
        void exhaustiveCheck;
        return Promise.resolve(
          controllerError({
            kind: "UnsupportedAction",
            action,
            message: "Unsupported meta action.",
          }),
        );
      }
    }
  }

  private getClient(): GameClient {
    if (!this.client) {
      throw new Error("Connection unavailable.");
    }
    return this.client;
  }

  private ensureClientFor(
    action: ControllerActionKind,
  ): ControllerResult<GameClient> {
    if (!this.client || !this.isConnected()) {
      return controllerError({
        kind: "TransientTransport",
        action,
        message: `Cannot ${CONTROLLER_ACTION_DESCRIPTIONS[action]} because the game server connection is unavailable.`,
      });
    }
    return controllerOk(this.client);
  }

  private runClientAction<K extends ControllerActionKind>(
    action: K,
    payload?: ActionRequestPayload<K>,
  ): Promise<ControllerResult<void>> {
    const clientResult = this.ensureClientFor(action);
    if (!clientResult.ok) {
      return Promise.resolve(controllerError(clientResult.error));
    }
    return this.dispatchActionRequest(clientResult.value, action, payload);
  }

  private async dispatchActionRequest<K extends ControllerActionKind>(
    client: GameClient,
    action: K,
    payload?: ActionRequestPayload<K>,
  ): Promise<ControllerResult<void>> {
    try {
      const outcome = await client.sendActionRequest(action, payload);
      return this.translateOutcome(action, outcome);
    } catch (error) {
      return controllerError({
        kind: "Unknown",
        action,
        message:
          error instanceof Error
            ? error.message
            : "Unexpected error while sending action request.",
        cause: error,
      });
    }
  }

  private translateOutcome(
    action: ControllerActionKind,
    outcome: ActionRequestOutcome,
  ): ControllerResult<void> {
    switch (outcome.kind) {
      case "ack":
        return controllerOk(undefined);
      case "nack":
        return controllerError({
          kind: "ActionRejected",
          action,
          code: outcome.code,
          message: outcome.message,
        });
      case "transport-error":
        return controllerError({
          kind: "TransientTransport",
          action,
          message:
            outcome.message ??
            `Unable to ${CONTROLLER_ACTION_DESCRIPTIONS[action]} due to connection issues.`,
        });
      default: {
        const exhaustiveCheck: never = outcome;
        void exhaustiveCheck;
        return controllerError({
          kind: "Unknown",
          action,
          message: "Unexpected controller outcome.",
        });
      }
    }
  }
}
