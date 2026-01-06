import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pause, Play } from "lucide-react";
import { Board, type BoardPawn } from "@/components/board";
import { fetchShowcaseGame } from "@/lib/api";
import { buildHistoryState } from "@/lib/history-utils";
import { computeLastMoves, resolvePlayerColor } from "@/lib/gameViewModel";
import { type PlayerColor } from "@/lib/player-colors";
import {
  buildGameConfigurationFromSerialized,
  hydrateGameStateFromSerialized,
} from "@/lib/game-state-utils";
import { pawnId } from "../../../shared/domain/game-utils";
import type { GameSnapshot, PlayerId } from "../../../shared/domain/game-types";
import type { GameShowcaseResponse } from "../../../shared/contracts/games";

export function GameShowcase() {
  const [isPlaying, setIsPlaying] = useState(true);
  const [showcase, setShowcase] = useState<{
    matchStatus: GameShowcaseResponse["matchStatus"];
    state: GameShowcaseResponse["state"];
    gameState: ReturnType<typeof hydrateGameStateFromSerialized>;
  } | null>(null);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const autoplayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(
    (ref: MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
      if (ref.current) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    },
    [],
  );

  const clearAllTimers = useCallback(() => {
    clearTimer(autoplayTimeoutRef);
    clearTimer(endTimeoutRef);
    clearTimer(retryTimeoutRef);
  }, [clearTimer]);

  useEffect(() => {
    return () => clearAllTimers();
  }, [clearAllTimers]);

  const loadShowcaseGame = useCallback(async () => {
    if (isLoading) return;
    clearAllTimers();
    setIsLoading(true);
    setHasError(false);
    try {
      const data = await fetchShowcaseGame();
      const config = buildGameConfigurationFromSerialized(data.state);
      const hydrated = hydrateGameStateFromSerialized(data.state, config);
      setShowcase({
        matchStatus: data.matchStatus,
        state: data.state,
        gameState: hydrated,
      });
      setHistoryCursor(-1);
    } catch (error) {
      console.error("[game-showcase] Failed to fetch showcase game", error);
      setShowcase(null);
      setHasError(true);
      setHistoryCursor(-1);
    } finally {
      setIsLoading(false);
    }
  }, [clearAllTimers, isLoading]);

  useEffect(() => {
    if (!isPlaying) {
      clearAllTimers();
      return;
    }
    if (hasError || showcase || isLoading) return;
    void loadShowcaseGame();
  }, [
    isPlaying,
    hasError,
    showcase,
    isLoading,
    loadShowcaseGame,
    clearAllTimers,
  ]);

  useEffect(() => {
    clearTimer(autoplayTimeoutRef);
    clearTimer(endTimeoutRef);
    if (!isPlaying || hasError || !showcase) return;

    const maxIndex = showcase.gameState.history.length - 1;
    if (historyCursor < maxIndex) {
      autoplayTimeoutRef.current = setTimeout(() => {
        setHistoryCursor((prev) => Math.min(prev + 1, maxIndex));
      }, 200);
      return;
    }

    endTimeoutRef.current = setTimeout(() => {
      void loadShowcaseGame();
    }, 3000);
  }, [
    isPlaying,
    hasError,
    showcase,
    historyCursor,
    loadShowcaseGame,
    clearTimer,
  ]);

  useEffect(() => {
    clearTimer(retryTimeoutRef);
    if (!isPlaying || !hasError) return;
    retryTimeoutRef.current = setTimeout(() => {
      void loadShowcaseGame();
    }, 60000);
  }, [isPlaying, hasError, loadShowcaseGame, clearTimer]);

  const displayState = useMemo(() => {
    if (!showcase) return null;
    return (
      buildHistoryState({
        config: showcase.gameState.config,
        historyEntries: showcase.gameState.history,
        cursor: historyCursor,
      }) ?? showcase.gameState
    );
  }, [showcase, historyCursor]);

  const playerColors = useMemo(() => {
    const colors: Record<PlayerId, PlayerColor> = { 1: "red", 2: "blue" };
    if (!showcase) return colors;
    showcase.matchStatus.players.forEach((player) => {
      if (!player.appearance?.pawnColor) return;
      colors[player.playerId] = resolvePlayerColor(player.appearance.pawnColor);
    });
    if (colors[1] === colors[2]) {
      colors[1] = "red";
      colors[2] = "blue";
    }
    return colors;
  }, [showcase]);

  const boardPawns = useMemo((): BoardPawn[] => {
    if (!displayState || !showcase) return [];
    const isClassicVariant = displayState.config.variant === "classic";
    const playersById = new Map(
      showcase.matchStatus.players.map((player) => [player.playerId, player]),
    );

    return displayState.getPawns().map((pawn) => {
      const isClassicGoal = isClassicVariant && pawn.type === "mouse";
      const visualType = isClassicGoal ? "home" : pawn.type;
      const visualPlayerId = isClassicGoal
        ? pawn.playerId === 1
          ? 2
          : 1
        : pawn.playerId;
      const player = playersById.get(visualPlayerId);

      const pawnStyle = (() => {
        if (visualType === "cat") {
          const style = player?.appearance?.catSkin;
          return style && style !== "default" ? style : undefined;
        }
        if (visualType === "mouse") {
          const style = player?.appearance?.mouseSkin;
          return style && style !== "default" ? style : undefined;
        }
        const style = player?.appearance?.homeSkin;
        return style && style !== "default" ? style : undefined;
      })();

      return {
        ...pawn,
        id: pawnId(pawn),
        pawnStyle,
        visualType,
        visualPlayerId,
      };
    });
  }, [displayState, showcase]);

  const boardWalls = useMemo(() => {
    if (!displayState) return [];
    return displayState.grid.getWalls().map((wall) => ({
      ...wall,
      state: "placed" as const,
    }));
  }, [displayState]);

  const lastMoves = useMemo(() => {
    if (!displayState) return null;
    return computeLastMoves(displayState, playerColors);
  }, [displayState, playerColors]);

  const boardRows = displayState?.config.boardHeight ?? 8;
  const boardCols = displayState?.config.boardWidth ?? 8;

  const orderedPlayers = useMemo(() => {
    if (!showcase) return [];
    return [...showcase.matchStatus.players].sort(
      (a, b) => a.playerId - b.playerId,
    );
  }, [showcase]);

  const title = useMemo(() => {
    if (!showcase || orderedPlayers.length < 2) return null;
    const formatPlayer = (player: GameSnapshot["players"][number]) => {
      const rating = player.elo != null ? ` (${player.elo})` : "";
      return `${player.displayName}${rating}`;
    };
    const formatDate = (timestamp: number) =>
      new Date(timestamp).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      });
    return `Game showcase: ${formatPlayer(orderedPlayers[0])} vs ${formatPlayer(
      orderedPlayers[1],
    )} (${formatDate(showcase.matchStatus.createdAt)})`;
  }, [showcase, orderedPlayers]);

  const handleOpenReplay = useCallback(() => {
    if (!showcase) return;
    void navigate({
      to: `/game/${showcase.matchStatus.id}`,
      state: { replayPlyIndex: historyCursor },
    });
  }, [navigate, showcase, historyCursor]);

  return (
    <Card
      className="relative overflow-hidden bg-card border-2 border-border transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] cursor-pointer"
      onClick={handleOpenReplay}
      role="button"
    >
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium text-muted-foreground">
            {title ?? "Game showcase"}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setIsPlaying((prev) => !prev);
            }}
          >
            {isPlaying ? (
              <>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Play
              </>
            )}
          </Button>
        </div>

        {/* Game Board */}
        <div className="w-full">
          <Board
            rows={boardRows}
            cols={boardCols}
            pawns={boardPawns}
            walls={boardWalls}
            lastMoves={lastMoves ?? undefined}
            playerColors={playerColors}
          />
        </div>
      </div>
    </Card>
  );
}
