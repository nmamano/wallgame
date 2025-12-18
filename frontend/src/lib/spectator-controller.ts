import { SpectatorClient } from "@/lib/spectator-client";
import type {
  GameSnapshot,
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
