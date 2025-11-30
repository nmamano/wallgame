import type {
  GameSnapshot,
  GameActionPayload,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type { ServerMessage } from "../../../shared/contracts/websocket-messages";

export interface GameClientHandlers {
  onState?: (state: SerializedGameState) => void;
  onMatchStatus?: (snapshot: GameSnapshot) => void;
  onError?: (message: string) => void;
}

const buildSocketUrl = (gameId: string, token: string): string => {
  const base = new URL(window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/ws/games/${gameId}`;
  base.search = `token=${token}`;
  return base.toString();
};

export class GameClient {
  private socket: WebSocket | null = null;
  private handlers: GameClientHandlers = {};

  constructor(
    private readonly params: {
      gameId: string;
      socketToken: string;
    },
  ) {}

  connect(handlers: GameClientHandlers): void {
    this.handlers = handlers;
    if (typeof window === "undefined") {
      handlers.onError?.("WebSocket not available in this environment.");
      return;
    }
    const url = buildSocketUrl(this.params.gameId, this.params.socketToken);
    console.debug("[game-client] opening websocket", {
      gameId: this.params.gameId,
    });
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      console.debug("[game-client] websocket open", {
        gameId: this.params.gameId,
      });
    });
    this.socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : null;
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as ServerMessage;
        if (payload.type === "state") {
          console.debug("[game-client] received state", {
            gameId: this.params.gameId,
            turn: payload.state.turn,
            moveCount: payload.state.moveCount,
          });
          this.handlers.onState?.(payload.state);
        } else if (payload.type === "match-status") {
          console.debug("[game-client] received match status", {
            gameId: this.params.gameId,
            status: payload.snapshot.status,
          });
          this.handlers.onMatchStatus?.(payload.snapshot);
        } else if (payload.type === "error") {
          this.handlers.onError?.(payload.message);
        }
      } catch (error) {
        console.error("Failed to parse websocket message", error);
      }
    });
    this.socket.addEventListener("close", () => {
      console.debug("[game-client] websocket closed", {
        gameId: this.params.gameId,
      });
      this.handlers.onError?.("Connection to server closed.");
    });
    this.socket.addEventListener("error", (event) => {
      console.error("[game-client] websocket error", {
        gameId: this.params.gameId,
        readyState: this.socket?.readyState,
        event,
      });
      this.handlers.onError?.("WebSocket error occurred.");
    });
  }

  sendMove(actions: GameActionPayload[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.handlers.onError?.("Socket not connected.");
      return;
    }
    console.debug("[game-client] send move", {
      gameId: this.params.gameId,
      actionCount: actions.length,
    });
    this.socket.send(JSON.stringify({ type: "submit-move", actions }));
  }

  sendResign(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.handlers.onError?.("Socket not connected.");
      return;
    }
    this.socket.send(JSON.stringify({ type: "resign" }));
  }

  close(): void {
    this.socket?.close();
  }
}
