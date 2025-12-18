import { GameClient } from "@/lib/game-client";
import type { GameClientHandlers } from "@/lib/game-client";
import {
  LocalHumanController,
  getCapabilitiesForType,
  type ControllerCapabilities,
  type DrawDecision,
  type DrawOfferContext,
  type PlayerControllerContext,
  type RemoteHumanController,
  type RematchDecision,
  type TakebackDecision,
  type TakebackRequestContext,
} from "@/lib/player-controllers";
import type { PlayerType } from "@/lib/gameViewModel";
import type { Move, PlayerId } from "../../../shared/domain/game-types";

export type RemoteControllerHandlers = GameClientHandlers;

export class RemotePlayerController implements RemoteHumanController {
  public readonly kind = "remote-human" as const;
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
    this.client?.close();
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

  resign(): Promise<void> {
    const client = this.getClient();
    client.sendResign();
    return Promise.resolve();
  }

  offerDraw(): Promise<void> {
    const client = this.getClient();
    client.sendDrawOffer();
    return Promise.resolve();
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

  requestTakeback(): Promise<void> {
    const client = this.getClient();
    client.sendTakebackOffer();
    return Promise.resolve();
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

  giveTime(seconds: number): Promise<void> {
    const client = this.getClient();
    client.sendGiveTime(seconds);
    return Promise.resolve();
  }

  offerRematch(): Promise<void> {
    const client = this.getClient();
    client.sendRematchOffer();
    return Promise.resolve();
  }

  respondToRematch(decision: RematchDecision): Promise<void> {
    const client = this.getClient();
    if (decision === "accepted") {
      client.sendRematchAccept();
      return Promise.resolve();
    }
    client.sendRematchReject();
    return Promise.resolve();
  }

  private getClient(): GameClient {
    if (!this.client) {
      throw new Error("Connection unavailable.");
    }
    return this.client;
  }
}
