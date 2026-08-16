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
  ChatChannel,
  ChatErrorCode,
} from "../../../shared/contracts/websocket-messages";
import type {
  ControllerActionKind,
  ActionRequestPayload,
  ActionNackCode,
} from "../../../shared/contracts/controller-actions";

/**
 * What the page can tell the player about the connection.
 *
 * "reconnecting" is the state that did not exist before board 97f9d99c: a
 * closed game socket was permanent and silent, so the page went on rendering a
 * live game it could no longer send to or hear from.
 */
export type TransportState = "connecting" | "open" | "reconnecting";

export interface GameClientHandlers {
  onTransportState?: (state: TransportState) => void;
  onState?: (state: SerializedGameState) => void;
  onMatchStatus?: (snapshot: GameSnapshot) => void;
  onWelcome?: (socketId: string) => void;
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
  onChatMessage?: (message: {
    channel: ChatChannel;
    senderId: string;
    senderName: string;
    text: string;
    timestamp: number;
  }) => void;
  onChatError?: (error: { code: ChatErrorCode; message: string }) => void;
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

/**
 * How long to wait before each reconnect attempt, in order; the last entry
 * repeats for as long as the outage lasts.
 *
 * The delay is capped and the ATTEMPT COUNT is not. A fixed cap would strand a
 * player whose outage outlived it - a lift, a tunnel, a laptop asleep over
 * lunch - and leaving them on a board that can never recover is the fault this
 * whole change exists to remove. Giving up is only honest with a visible
 * gave-up state and a Retry the player can press, which is more machinery than
 * the problem needs.
 */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10000] as const;

const reconnectDelayFor = (attempt: number): number =>
  RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];

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
  private pingInterval: number | null = null;
  /**
   * Which attempt owns the client right now.
   *
   * Every listener captures the generation it was registered for and ignores
   * anything that does not match. A websocket keeps delivering to its own
   * listeners after it has been replaced, so without this a dying socket's
   * close event would clear the LIVE socket's ping timer and start a second
   * reconnect chain beside the one already running.
   */
  private generation = 0;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private closedByClient = false;
  private connected = false;

  constructor(
    private readonly params: {
      gameId: string;
      socketToken: string;
    },
  ) {}

  /**
   * Idempotent: a second call is ignored rather than opening a rival socket.
   */
  connect(handlers: GameClientHandlers): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.handlers = handlers;
    if (typeof window === "undefined") {
      handlers.onError?.("WebSocket not available in this environment.");
      return;
    }
    this.openSocket("connecting");
  }

  private openSocket(reportedState: TransportState): void {
    const generation = ++this.generation;
    const url = buildSocketUrl(this.params.gameId, this.params.socketToken);
    console.debug("[game-client] opening websocket", {
      gameId: this.params.gameId,
      generation,
    });
    this.handlers.onTransportState?.(reportedState);
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      console.debug("[game-client] websocket open", {
        gameId: this.params.gameId,
        generation,
      });
      // A reconnect that reached "open" costs the next outage nothing: the
      // schedule restarts at its shortest delay.
      this.reconnectAttempt = 0;
      this.handlers.onTransportState?.("open");
      // Start ping interval to keep connection alive (Fly.io has ~60s idle timeout)
      this.pingInterval = window.setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    });
    this.socket.addEventListener("message", (event) => {
      if (generation !== this.generation) return;
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
        } else if (payload.type === "welcome") {
          console.debug("[game-client] received welcome", {
            gameId: this.params.gameId,
            socketId: payload.socketId,
          });
          this.handlers.onWelcome?.(payload.socketId);
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
      if (generation !== this.generation) return;
      console.debug("[game-client] websocket closed", {
        gameId: this.params.gameId,
        generation,
      });
      this.clearPingInterval();
      this.resolveAllInflightAsTransportError("Connection to server closed.");
      if (this.closedByClient) {
        return;
      }
      this.scheduleReconnect();
    });
    this.socket.addEventListener("error", (event) => {
      if (generation !== this.generation) return;
      console.error("[game-client] websocket error", {
        gameId: this.params.gameId,
        readyState: this.socket?.readyState,
        event,
      });
      this.resolveAllInflightAsTransportError("WebSocket error occurred.");
      // No reconnect is started here. A failed socket always follows its error
      // with a close, and starting a chain from both would run two.
    });
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelayFor(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.handlers.onTransportState?.("reconnecting");
    console.debug("[game-client] scheduling reconnect", {
      gameId: this.params.gameId,
      attempt: this.reconnectAttempt,
      delay,
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByClient) return;
      this.openSocket("reconnecting");
    }, delay);
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

  sendChatMessage(channel: ChatChannel, text: string): void {
    this.send({ type: "chat-message", channel, text });
  }

  /**
   * A close the caller ASKED for, which must not look like one it suffered.
   *
   * The flag is set and the pending retry cancelled BEFORE the socket is
   * closed, so the close event that follows cannot start a reconnect to a game
   * the page has left.
   */
  close(reason = "unspecified"): void {
    this.closedByClient = true;
    this.clearReconnectTimer();
    this.clearPingInterval();
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

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingInterval(): void {
    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
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
