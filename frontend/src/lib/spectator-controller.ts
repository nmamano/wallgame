import { SpectatorClient } from "@/lib/spectator-client";
import type {
  GameSnapshot,
  SerializedGameState,
} from "../../../shared/domain/game-types";

export interface SpectatorControllerHandlers {
  onSnapshot: (snapshot: GameSnapshot) => void;
  onState: (state: SerializedGameState) => void;
  onError?: (message: string) => void;
  onStatusChange?: (status: { isConnected: boolean }) => void;
  onRematchStarted?: (newGameId: string) => void;
}

export class SpectatorSession {
  private client: SpectatorClient | null = null;

  constructor(private readonly gameId: string) {}

  connect(
    handlers: SpectatorControllerHandlers,
    bootstrap: { snapshot: GameSnapshot; state: SerializedGameState },
  ): void {
    handlers.onSnapshot(bootstrap.snapshot);
    handlers.onState(bootstrap.state);
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
      onRematchStarted: (newGameId) => {
        handlers.onRematchStarted?.(newGameId);
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
