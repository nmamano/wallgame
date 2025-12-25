import { SpectatorClient } from "@/lib/spectator-client";
import type {
  GameSnapshot,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type {
  ChatChannel,
  ChatErrorCode,
} from "../../../shared/contracts/websocket-messages";

export interface SpectatorControllerHandlers {
  onSnapshot: (snapshot: GameSnapshot) => void;
  onState: (state: SerializedGameState) => void;
  onWelcome?: (socketId: string) => void;
  onError?: (message: string) => void;
  onStatusChange?: (status: { isConnected: boolean }) => void;
  onRematchStarted?: (newGameId: string) => void;
  onChatMessage?: (message: {
    channel: ChatChannel;
    senderId: string;
    senderName: string;
    text: string;
    timestamp: number;
  }) => void;
  onChatError?: (error: { code: ChatErrorCode; message: string }) => void;
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
      onWelcome: (socketId) => {
        handlers.onWelcome?.(socketId);
      },
      onError: (message) => {
        handlers.onError?.(message);
      },
      onRematchStarted: (newGameId) => {
        handlers.onRematchStarted?.(newGameId);
      },
      onChatMessage: (message) => {
        handlers.onChatMessage?.(message);
      },
      onChatError: (error) => {
        handlers.onChatError?.(error);
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

  /**
   * Spectators can only send messages to the audience channel.
   */
  sendChatMessage(text: string): void {
    this.client?.sendChatMessage(text);
  }
}
