import type {
  Variant,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type {
  EvalClientMessage,
  EvalServerMessage,
  EvalHistoryEntry,
} from "../../../shared/contracts/eval-protocol";

// Re-export for consumers
export type { EvalHistoryEntry } from "../../../shared/contracts/eval-protocol";

export interface EvalClientHandlers {
  onHandshakeAccepted?: () => void;
  onHandshakeRejected?: (code: string, message: string) => void;
  // V2 (deprecated): per-request eval response
  onEvalResponse?: (
    requestId: string,
    evaluation: number,
    bestMove?: string,
  ) => void;
  // V3: full evaluation history received (after BGS initialization)
  onEvalHistory?: (entries: EvalHistoryEntry[]) => void;
  // V3: streaming update when new move is made in live game
  onEvalUpdate?: (ply: number, evaluation: number, bestMove: string) => void;
  // V3: BGS initialization in progress (for showing loading state)
  onEvalPending?: (totalMoves: number) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
  onOpen?: () => void;
}

const buildEvalSocketUrl = (gameId: string, socketToken?: string): string => {
  const base = new URL(window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/ws/eval/${gameId}`;
  if (socketToken) {
    base.searchParams.set("token", socketToken);
  }
  return base.toString();
};

/**
 * WebSocket client for requesting position evaluations from official bots.
 * Used by the evaluation bar feature.
 */
export class EvalClient {
  private socket: WebSocket | null = null;
  private handlers: EvalClientHandlers = {};
  private pingInterval: number | null = null;
  private handshakeCompleted = false;

  constructor(private readonly gameId: string) {}

  connect(
    handlers: EvalClientHandlers,
    variant: Variant,
    boardWidth: number,
    boardHeight: number,
    socketToken?: string,
  ): void {
    this.handlers = handlers;
    if (typeof window === "undefined") {
      handlers.onError?.("WebSocket not available");
      return;
    }

    const url = buildEvalSocketUrl(this.gameId, socketToken);
    console.debug("[eval-client] opening websocket", {
      gameId: this.gameId,
    });
    this.socket = new WebSocket(url);

    this.socket.addEventListener("open", () => {
      console.debug("[eval-client] websocket open", {
        gameId: this.gameId,
      });
      this.handlers.onOpen?.();

      // Send handshake
      this.send({
        type: "eval-handshake",
        gameId: this.gameId,
        variant,
        boardWidth,
        boardHeight,
      });

      // Start ping interval to keep connection alive
      this.pingInterval = window.setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.send({ type: "ping" });
        }
      }, 30000);
    });

    this.socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : null;
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as EvalServerMessage;
        switch (payload.type) {
          case "eval-handshake-accepted":
            console.debug("[eval-client] handshake accepted", {
              gameId: this.gameId,
            });
            this.handshakeCompleted = true;
            this.handlers.onHandshakeAccepted?.();
            break;

          case "eval-handshake-rejected":
            console.warn("[eval-client] handshake rejected", {
              gameId: this.gameId,
              code: payload.code,
              message: payload.message,
            });
            this.handlers.onHandshakeRejected?.(payload.code, payload.message);
            break;

          case "eval-response":
            console.debug("[eval-client] received eval response", {
              gameId: this.gameId,
              requestId: payload.requestId,
              evaluation: payload.evaluation,
            });
            this.handlers.onEvalResponse?.(
              payload.requestId,
              payload.evaluation,
              payload.bestMove,
            );
            break;

          case "eval-error":
            console.warn("[eval-client] received eval error", {
              gameId: this.gameId,
              code: payload.code,
              message: payload.message,
            });
            this.handlers.onError?.(payload.message);
            break;

          case "pong":
            // Ignore pong responses
            break;

          // V3 BGS-based messages
          case "eval-pending":
            console.debug("[eval-client] BGS initialization pending", {
              gameId: this.gameId,
              totalMoves: payload.totalMoves,
            });
            this.handlers.onEvalPending?.(payload.totalMoves);
            break;

          case "eval-history":
            console.debug("[eval-client] received eval history", {
              gameId: this.gameId,
              entryCount: payload.entries.length,
            });
            this.handlers.onEvalHistory?.(payload.entries);
            break;

          case "eval-update":
            console.debug("[eval-client] received eval update", {
              gameId: this.gameId,
              ply: payload.ply,
              evaluation: payload.evaluation,
            });
            this.handlers.onEvalUpdate?.(
              payload.ply,
              payload.evaluation,
              payload.bestMove,
            );
            break;
        }
      } catch (error) {
        console.error("Failed to parse eval websocket message", error);
      }
    });

    this.socket.addEventListener("close", (event) => {
      console.debug("[eval-client] websocket closed", {
        gameId: this.gameId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      this.clearPingInterval();
      this.handlers.onClose?.();
    });

    this.socket.addEventListener("error", () => {
      console.error("[eval-client] websocket error", {
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

  private send(message: EvalClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Request an evaluation for the given game state.
   * Returns the request ID for matching the response.
   *
   * @deprecated V2 protocol - in V3, evaluations are pushed from server via
   * onEvalHistory (initial) and onEvalUpdate (streaming). This method is kept
   * for backward compatibility during migration.
   */
  requestEval(requestId: string, state: SerializedGameState): void {
    if (!this.handshakeCompleted) {
      console.warn("[eval-client] cannot request eval before handshake");
      return;
    }
    this.send({
      type: "eval-request",
      requestId,
      state,
    });
  }

  /**
   * Check if the client is connected and handshake completed.
   */
  isReady(): boolean {
    return (
      this.handshakeCompleted &&
      this.socket !== null &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  close(): void {
    this.clearPingInterval();
    this.handshakeCompleted = false;
    this.socket?.close();
    this.socket = null;
  }
}
