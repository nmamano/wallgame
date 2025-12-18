import { SpectatorClient } from "@/lib/spectator-client";
import {
  getCapabilitiesForType,
  type DrawDecision,
  type SpectatorPlayerController,
  type TakebackDecision,
} from "@/lib/player-controllers";
import type { PlayerType } from "@/lib/gameViewModel";
import type {
  GameSnapshot,
  Move,
  PlayerId,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type { SpectateResponse } from "../../../shared/contracts/games";

export interface SpectatorControllerHandlers {
  onSnapshot: (snapshot: GameSnapshot) => void;
  onState: (state: SerializedGameState) => void;
  onError?: (message: string) => void;
  onStatusChange?: (status: { isConnected: boolean }) => void;
}

export class SpectatorSession {
  private client: SpectatorClient | null = null;

  constructor(private readonly gameId: string) {}

  async connect(handlers: SpectatorControllerHandlers): Promise<void> {
    try {
      const res = await fetch(`/api/games/${this.gameId}/spectate`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? "Failed to load game");
      }
      const data = (await res.json()) as SpectateResponse;
      handlers.onSnapshot(data.snapshot);
      handlers.onState(data.state);
    } catch (error) {
      handlers.onError?.(
        error instanceof Error ? error.message : "Failed to load game",
      );
      return;
    }

    this.client = new SpectatorClient(this.gameId);
    this.client.connect({
      onState: (state) => {
        handlers.onState(state);
      },
      onMatchStatus: (snapshot) => {
        handlers.onSnapshot(snapshot);
      },
      onError: (message) => {
        handlers.onError?.(message);
      },
      onOpen: () => {
        handlers.onStatusChange?.({ isConnected: true });
      },
      onClose: () => {
        handlers.onStatusChange?.({ isConnected: false });
      },
    });
  }

  disconnect(): void {
    this.client?.close();
    this.client = null;
  }
}

const SPECTATOR_CAPABILITIES = getCapabilitiesForType("friend");

export class RemoteSpectatorPlayerController implements SpectatorPlayerController {
  public readonly kind = "remote-spectator" as const;
  public readonly capabilities = SPECTATOR_CAPABILITIES;

  constructor(
    public readonly playerId: PlayerId,
    public readonly playerType: PlayerType,
  ) {}

  async makeMove(): Promise<Move> {
    return Promise.reject(new Error("Spectators cannot make moves."));
  }

  async respondToDrawOffer(): Promise<DrawDecision> {
    return Promise.reject(
      new Error("Spectators cannot respond to draw offers."),
    );
  }

  async respondToTakebackRequest(): Promise<TakebackDecision> {
    return Promise.reject(
      new Error("Spectators cannot respond to takeback requests."),
    );
  }

  async resign(): Promise<void> {
    return Promise.reject(new Error("Spectators cannot resign."));
  }

  async offerDraw(): Promise<void> {
    return Promise.reject(new Error("Spectators cannot offer draws."));
  }

  async respondToRemoteDraw(): Promise<void> {
    return Promise.reject(
      new Error("Spectators cannot respond to draw offers."),
    );
  }

  async requestTakeback(): Promise<void> {
    return Promise.reject(new Error("Spectators cannot request takebacks."));
  }

  async respondToRemoteTakeback(): Promise<void> {
    return Promise.reject(
      new Error("Spectators cannot respond to takeback requests."),
    );
  }

  async giveTime(): Promise<void> {
    return Promise.reject(new Error("Spectators cannot adjust clocks."));
  }

  async offerRematch(): Promise<void> {
    return Promise.reject(new Error("Spectators cannot offer rematches."));
  }

  async respondToRematch(): Promise<void> {
    return Promise.reject(
      new Error("Spectators cannot respond to rematch offers."),
    );
  }

  handleStateUpdate(): void {
    // Spectators do not manage state locally.
  }

  cancel(): void {
    // Nothing to cancel for spectators.
  }
}
