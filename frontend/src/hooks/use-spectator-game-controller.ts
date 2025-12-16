import { useMemo, useState, useEffect, useRef } from "react";
import { useSpectatorSession } from "@/hooks/use-spectator-session";
import { pawnId } from "../../../shared/domain/game-utils";
import { moveToStandardNotation } from "../../../shared/domain/standard-notation";
import {
  buildGameConfigurationFromSerialized,
  hydrateGameStateFromSerialized,
} from "@/lib/game-state-utils";
import { formatWinReason, resolvePlayerColor } from "@/lib/gameViewModel";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import type { BoardPawn } from "@/components/board";

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

/**
 * Spectator-specific game controller.
 * Returns a simplified version of the game controller interface
 * with all interaction handlers as no-ops.
 */
export function useSpectatorGameController(gameId: string) {
  const spectatorSession = useSpectatorSession(gameId);
  const [clockTick, setClockTick] = useState(() => Date.now());

  // Clock tick for timer updates
  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Derive game state from serialized state
  const { config, gameState } = useMemo(() => {
    if (!spectatorSession.state) {
      return { config: null, gameState: null };
    }
    const config = buildGameConfigurationFromSerialized(spectatorSession.state);
    const gameState = hydrateGameStateFromSerialized(
      spectatorSession.state,
      config,
    );
    return { config, gameState };
  }, [spectatorSession.state]);

  const matchSnapshot = spectatorSession.snapshot;

  // Determine player positions: host on bottom, joiner on top
  const players = useMemo(() => {
    if (!matchSnapshot) return { bottom: null, top: null };
    const host = matchSnapshot.players.find((p) => p.role === "host") ?? null;
    const joiner =
      matchSnapshot.players.find((p) => p.role === "joiner") ?? null;
    return { bottom: host, top: joiner };
  }, [matchSnapshot]);

  // Resolve player colors from their appearances
  const playerColorsForBoard = useMemo((): Record<PlayerId, PlayerColor> => {
    const colors: Record<PlayerId, PlayerColor> = {
      1: DEFAULT_PLAYER_COLORS[1],
      2: DEFAULT_PLAYER_COLORS[2],
    };
    if (matchSnapshot) {
      matchSnapshot.players.forEach((player) => {
        if (player.appearance?.pawnColor) {
          colors[player.playerId] = resolvePlayerColor(
            player.appearance.pawnColor,
          );
        }
      });
    }
    // Handle color collision
    if (colors[1] === colors[2]) {
      const baseColor = colors[1];
      if (!baseColor.endsWith("-dark") && !baseColor.endsWith("-light")) {
        colors[1] = `${baseColor}-dark` as PlayerColor;
        colors[2] = `${baseColor}-light` as PlayerColor;
      }
    }
    return colors;
  }, [matchSnapshot]);

  // Build display pawns
  const boardPawns = useMemo((): BoardPawn[] => {
    if (!gameState) return [];
    return gameState.getPawns().map((pawn) => {
      const player = matchSnapshot?.players.find(
        (p) => p.playerId === pawn.playerId,
      );
      let pawnStyle: string | undefined;
      if (pawn.type === "cat" && player?.appearance?.catSkin) {
        pawnStyle = player.appearance.catSkin;
      } else if (pawn.type === "mouse" && player?.appearance?.mouseSkin) {
        pawnStyle = player.appearance.mouseSkin;
      }
      return {
        ...pawn,
        id: pawnId(pawn),
        pawnStyle,
      };
    });
  }, [gameState, matchSnapshot]);

  // Build walls
  const boardWalls = useMemo(() => {
    if (!gameState) return [];
    return gameState.grid.getWalls().map((wall) => ({
      ...wall,
      state: "placed" as const,
    }));
  }, [gameState]);

  // Format history for display
  const formattedHistory = useMemo(() => {
    if (!gameState) return [];
    const rows = gameState.config.boardHeight;
    const entries = gameState.history.map((entry) => ({
      number: Math.ceil(entry.index / 2),
      notation: moveToStandardNotation(entry.move, rows),
    }));
    const paired: { num: number; white?: string; black?: string }[] = [];
    for (let i = 0; i < entries.length; i += 2) {
      paired.push({
        num: entries[i].number,
        white: entries[i]?.notation,
        black: entries[i + 1]?.notation,
      });
    }
    return paired;
  }, [gameState]);

  // Track clock tick reference for time display
  const gameStateRef = useRef(gameState);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // Compute time left (read-only display)
  const displayedTimeLeft = useMemo(() => {
    const base: Record<PlayerId, number> = {
      1: gameState?.timeLeft?.[1] ?? 0,
      2: gameState?.timeLeft?.[2] ?? 0,
    };
    const state = gameStateRef.current;
    if (
      state &&
      gameState &&
      state.status === "playing" &&
      gameState.status === "playing" &&
      state.turn === gameState.turn
    ) {
      const elapsed = (Date.now() - state.lastMoveTime) / 1000;
      base[state.turn] = Math.max(0, base[state.turn] - elapsed);
    }
    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, clockTick]);

  const gameStatus = gameState?.status ?? "playing";
  const gameResult = gameState?.result ?? null;
  const gameTurn = gameState?.turn ?? 1;
  const rows = config?.boardHeight ?? 9;
  const cols = config?.boardWidth ?? 9;

  // Build player objects for timers
  const buildTimerPlayer = (
    playerSummary: typeof players.bottom,
    playerId: PlayerId,
  ) => {
    if (!playerSummary) return null;
    return {
      id: `p${playerId}`,
      playerId,
      name: playerSummary.displayName,
      rating: playerSummary.elo ?? 1500,
      color: playerColorsForBoard[playerId],
      type: "friend" as const,
      isOnline: playerSummary.connected,
    };
  };

  const bottomPlayer = players.bottom
    ? buildTimerPlayer(players.bottom, players.bottom.playerId)
    : null;
  const topPlayer = players.top
    ? buildTimerPlayer(players.top, players.top.playerId)
    : null;

  const getPlayerName = (id: PlayerId) =>
    matchSnapshot?.players.find((p) => p.playerId === id)?.displayName ??
    `Player ${id}`;

  // No-op handlers for spectators
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const noop = () => {};

  return {
    isSpectator: true,
    matching: {
      isOpen: false,
      players: [],
      shareUrl: undefined,
      statusMessage: undefined,
      canAbort: false,
      onAbort: noop,
    },
    board: {
      gameStatus,
      gameState,
      isMultiplayerMatch: true,
      isLoadingConfig: spectatorSession.isLoading,
      loadError: spectatorSession.error,
      winnerPlayer: null,
      winReason: gameResult?.reason ? formatWinReason(gameResult.reason) : "",
      scoreboardEntries: [],
      rematchState: {
        status: "idle" as const,
        responses: { 1: "pending" as const, 2: "pending" as const },
        requestId: 0,
      },
      rematchResponseSummary: [],
      rematchStatusText:
        gameStatus === "finished"
          ? "Waiting for players to decide on a rematch..."
          : "",
      primaryLocalPlayerId: null,
      userRematchResponse: null,
      handleAcceptRematch: noop,
      handleDeclineRematch: noop,
      handleProposeRematch: noop,
      openRematchWindow: noop,
      handleExitAfterMatch: () => window.history.back(),
      rows,
      cols,
      boardPawns,
      boardWalls,
      stagedArrows: [],
      playerColorsForBoard,
      interactionLocked: true,
      lastMove: undefined,
      draggingPawnId: null,
      selectedPawnId: null,
      stagedActionsCount: 0,
      actionablePlayerId: null,
      onCellClick: noop,
      onWallClick: noop,
      onPawnClick: noop,
      onPawnDragStart: noop,
      onPawnDragEnd: noop,
      onCellDrop: noop,
      stagedActions: [],
      activeLocalPlayerId: null,
      hasActionMessage: false,
      actionError: null,
      actionStatusText: null,
      clearStagedActions: noop,
      commitStagedActions: noop,
    },
    timers: {
      topPlayer,
      bottomPlayer,
      displayedTimeLeft,
      gameTurn,
      thinkingPlayer: null,
      getPlayerMatchScore: () => null,
    },
    actions: {
      drawDecisionPrompt: null,
      takebackDecisionPrompt: null,
      incomingPassiveNotice: null,
      getPlayerName,
      respondToDrawPrompt: noop,
      respondToTakebackPrompt: noop,
      handleDismissIncomingNotice: noop,
      resignFlowPlayerId: null,
      pendingDrawForLocal: false,
      pendingDrawOffer: null,
      takebackPendingForLocal: false,
      pendingTakebackRequest: null,
      outgoingTimeInfo: null,
      canCancelDrawOffer: false,
      canCancelTakebackRequest: false,
      handleCancelResign: noop,
      handleConfirmResign: noop,
      handleCancelDrawOffer: noop,
      handleCancelTakebackRequest: noop,
      handleDismissOutgoingInfo: noop,
      actionButtonsDisabled: true,
      manualActionsDisabled: true,
      hasTakebackHistory: false,
      handleStartResign: noop,
      handleOfferDraw: noop,
      handleRequestTakeback: noop,
      handleGiveTime: noop,
    },
    chat: {
      activeTab: "history" as const,
      onTabChange: noop,
      formattedHistory,
      chatChannel: "game" as const,
      messages: [],
      chatInput: "",
      onChannelChange: noop,
      onInputChange: noop,
      onSendMessage: noop,
    },
    info: {
      config,
      defaultVariant: "standard" as const,
      defaultTimeControlPreset: "blitz" as const,
      soundEnabled: false,
      onSoundToggle: noop,
      interactionLocked: true,
      isMultiplayerMatch: true,
      unsupportedPlayers: [],
      placeholderCopy: {},
    },
  };
}
