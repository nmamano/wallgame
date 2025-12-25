import type {
  GameSnapshot,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type {
  ServerMessage,
  ChatChannel,
  ChatErrorCode,
} from "../../../shared/contracts/websocket-messages";

export interface SpectatorClientHandlers {
  onState?: (state: SerializedGameState) => void;
  onMatchStatus?: (snapshot: GameSnapshot) => void;
  onWelcome?: (socketId: string) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
  onOpen?: () => void;
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

const buildSpectatorSocketUrl = (gameId: string): string => {
  const base = new URL(window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/ws/games/${gameId}`;
  // No token parameter = spectator mode
  return base.toString();
};

/**
 * A read-only WebSocket client for spectators.
 * Unlike GameClient, this does not send moves or other game actions.
 */
export class SpectatorClient {
  private socket: WebSocket | null = null;
  private handlers: SpectatorClientHandlers = {};
  private pingInterval: number | null = null;

  constructor(private readonly gameId: string) {}

  connect(handlers: SpectatorClientHandlers): void {
    this.handlers = handlers;
    if (typeof window === "undefined") {
      handlers.onError?.("WebSocket not available");
      return;
    }

    const url = buildSpectatorSocketUrl(this.gameId);
    console.debug("[spectator-client] opening websocket", {
      gameId: this.gameId,
    });
    this.socket = new WebSocket(url);

    this.socket.addEventListener("open", () => {
      console.debug("[spectator-client] websocket open", {
        gameId: this.gameId,
      });
      this.handlers.onOpen?.();
      // Start ping interval to keep connection alive
      this.pingInterval = window.setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    });

    this.socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : null;
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as ServerMessage;
        if (payload.type === "state") {
          console.debug("[spectator-client] received state", {
            gameId: this.gameId,
            turn: payload.state.turn,
            moveCount: payload.state.moveCount,
          });
          this.handlers.onState?.(payload.state);
        } else if (payload.type === "match-status") {
          console.debug("[spectator-client] received match status", {
            gameId: this.gameId,
            status: payload.snapshot.status,
          });
          this.handlers.onMatchStatus?.(payload.snapshot);
        } else if (payload.type === "rematch-started") {
          this.handlers.onRematchStarted?.(payload.newGameId);
        } else if (payload.type === "welcome") {
          console.debug("[spectator-client] received welcome", {
            gameId: this.gameId,
            socketId: payload.socketId,
          });
          this.handlers.onWelcome?.(payload.socketId);
        } else if (payload.type === "chat-message") {
          this.handlers.onChatMessage?.({
            channel: payload.channel,
            senderId: payload.senderId,
            senderName: payload.senderName,
            text: payload.text,
            timestamp: payload.timestamp,
          });
        } else if (payload.type === "chat-error") {
          this.handlers.onChatError?.({
            code: payload.code,
            message: payload.message,
          });
        } else if (payload.type === "error") {
          this.handlers.onError?.(payload.message);
        }
        // Ignore pong and other messages
      } catch (error) {
        console.error("Failed to parse spectator websocket message", error);
      }
    });

    this.socket.addEventListener("close", (event) => {
      console.debug("[spectator-client] websocket closed", {
        gameId: this.gameId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      this.clearPingInterval();
      this.handlers.onClose?.();
    });

    this.socket.addEventListener("error", () => {
      console.error("[spectator-client] websocket error", {
        gameId: this.gameId,
      });
      this.handlers.onError?.("WebSocket error occurred");
    });
  }

  private clearPingInterval(): void {
    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  close(): void {
    this.clearPingInterval();
    this.socket?.close();
    this.socket = null;
  }

  /**
   * Spectators can only send messages to the audience channel.
   */
  sendChatMessage(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(
      JSON.stringify({ type: "chat-message", channel: "audience", text }),
    );
  }
}
