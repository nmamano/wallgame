import type {
  GameSnapshot,
  Move,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type {
  ClientMessage,
  ServerMessage,
  ActionRequestMessage,
  ActionAckMessage,
  ActionNackMessage,
} from "../../../shared/contracts/websocket-messages";
import type {
  ControllerActionKind,
  ActionRequestPayload,
  ActionNackCode,
} from "../../../shared/contracts/controller-actions";

export interface GameClientHandlers {
  onState?: (state: SerializedGameState) => void;
  onMatchStatus?: (snapshot: GameSnapshot) => void;
  onRematchOffer?: (playerId: number) => void;
  onRematchRejected?: (playerId: number) => void;
  onRematchStarted?: (payload: {
    newGameId: string;
    seat?: { token: string; socketToken: string };
  }) => void;
  onDrawOffer?: (playerId: number) => void;
  onDrawRejected?: (playerId: number) => void;
  onTakebackOffer?: (playerId: number) => void;
  onTakebackRejected?: (playerId: number) => void;
  onError?: (message: string) => void;
}

export type ActionRequestOutcome =
  | { kind: "ack" }
  | {
      kind: "nack";
      code: ActionNackCode;
      message?: string;
      retryable?: boolean;
    }
  | { kind: "transport-error"; message?: string };

interface InflightActionRequest {
  action: ControllerActionKind;
  resolve: (outcome: ActionRequestOutcome) => void;
  timeoutId: number;
}

const ACTION_RESPONSE_TIMEOUT_MS = 5000;

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
  private readonly inflightRequests = new Map<string, InflightActionRequest>();

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
        } else if (payload.type === "rematch-offer") {
          this.handlers.onRematchOffer?.(payload.playerId);
        } else if (payload.type === "rematch-rejected") {
          this.handlers.onRematchRejected?.(payload.playerId);
        } else if (payload.type === "rematch-started") {
          this.handlers.onRematchStarted?.({
            newGameId: payload.newGameId,
            seat: payload.seat,
          });
        } else if (payload.type === "draw-offer") {
          this.handlers.onDrawOffer?.(payload.playerId);
        } else if (payload.type === "draw-rejected") {
          this.handlers.onDrawRejected?.(payload.playerId);
        } else if (payload.type === "takeback-offer") {
          this.handlers.onTakebackOffer?.(payload.playerId);
        } else if (payload.type === "takeback-rejected") {
          this.handlers.onTakebackRejected?.(payload.playerId);
        } else if (payload.type === "actionAck") {
          this.handleActionAck(payload);
        } else if (payload.type === "actionNack") {
          this.handleActionNack(payload);
        }
      } catch (error) {
        console.error("Failed to parse websocket message", error);
      }
    });
    this.socket.addEventListener("close", () => {
      console.debug("[game-client] websocket closed", {
        gameId: this.params.gameId,
      });
      this.resolveAllInflightAsTransportError("Connection to server closed.");
      this.handlers.onError?.("Connection to server closed.");
    });
    this.socket.addEventListener("error", (event) => {
      console.error("[game-client] websocket error", {
        gameId: this.params.gameId,
        readyState: this.socket?.readyState,
        event,
      });
      this.resolveAllInflightAsTransportError("WebSocket error occurred.");
      this.handlers.onError?.("WebSocket error occurred.");
    });
  }

  private send(payload: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.handlers.onError?.("Socket not connected.");
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  sendActionRequest<K extends ControllerActionKind>(
    action: K,
    payload?: ActionRequestPayload<K>,
  ): Promise<ActionRequestOutcome> {
    const requestId = crypto.randomUUID();
    const message: ActionRequestMessage<K> = {
      type: "action-request",
      requestId,
      action,
    };
    if (payload !== undefined) {
      message.payload = payload;
    }

    return new Promise<ActionRequestOutcome>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        this.inflightRequests.delete(requestId);
        resolve({
          kind: "transport-error",
          message: "The server did not acknowledge the action.",
        });
      }, ACTION_RESPONSE_TIMEOUT_MS);

      this.inflightRequests.set(requestId, {
        action,
        resolve,
        timeoutId,
      });

      this.send(message as ClientMessage);
    });
  }

  sendMove(move: Move): void {
    console.debug("[game-client] send move", {
      gameId: this.params.gameId,
      actionCount: move.actions.length,
    });
    this.send({ type: "submit-move", move });
  }

  sendResign(): void {
    this.send({ type: "resign" });
  }

  sendGiveTime(seconds: number): void {
    this.send({ type: "give-time", seconds });
  }

  sendTakebackOffer(): void {
    this.send({ type: "takeback-offer" });
  }

  sendTakebackAccept(): void {
    this.send({ type: "takeback-accept" });
  }

  sendTakebackReject(): void {
    this.send({ type: "takeback-reject" });
  }

  sendDrawOffer(): void {
    this.send({ type: "draw-offer" });
  }

  sendDrawAccept(): void {
    this.send({ type: "draw-accept" });
  }

  sendDrawReject(): void {
    this.send({ type: "draw-reject" });
  }

  sendRematchOffer(): void {
    this.send({ type: "rematch-offer" });
  }

  sendRematchAccept(): void {
    this.send({ type: "rematch-accept" });
  }

  sendRematchReject(): void {
    this.send({ type: "rematch-reject" });
  }

  close(reason = "unspecified"): void {
    if (!this.socket) {
      return;
    }
    console.warn("[game-client] close()", {
      gameId: this.params.gameId,
      reason,
      stack: new Error().stack,
    });
    this.socket.close(1000, "Client closing connection");
  }

  private handleActionAck(message: ActionAckMessage): void {
    const entry = this.inflightRequests.get(message.requestId);
    if (!entry) {
      return;
    }
    window.clearTimeout(entry.timeoutId);
    this.inflightRequests.delete(message.requestId);
    entry.resolve({ kind: "ack" });
  }

  private handleActionNack(message: ActionNackMessage): void {
    const entry = this.inflightRequests.get(message.requestId);
    if (!entry) {
      return;
    }
    window.clearTimeout(entry.timeoutId);
    this.inflightRequests.delete(message.requestId);
    entry.resolve({
      kind: "nack",
      code: message.code,
      message: message.message,
      retryable: message.retryable,
    });
  }

  private resolveAllInflightAsTransportError(reason: string): void {
    if (this.inflightRequests.size === 0) {
      return;
    }
    this.inflightRequests.forEach((entry, requestId) => {
      window.clearTimeout(entry.timeoutId);
      entry.resolve({
        kind: "transport-error",
        message: reason,
      });
      this.inflightRequests.delete(requestId);
    });
  }
}
