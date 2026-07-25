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
import { fetchShowcaseGames } from "@/lib/api";
import { buildHistoryState } from "@/lib/history-utils";
import {
  computeLastMoves,
  computeLastWalls,
  resolvePlayerColor,
} from "@/lib/gameViewModel";
import { type PlayerColor } from "@/lib/player-colors";
import {
  buildGameConfigurationFromSerialized,
  hydrateGameStateFromSerialized,
} from "@/lib/game-state-utils";
import { isClassicVariant } from "../../../shared/domain/game-types";
import { pawnId } from "../../../shared/domain/game-utils";
import type { GameSnapshot, PlayerId } from "../../../shared/domain/game-types";
import type { ShowcaseGame } from "../../../shared/contracts/games";

/**
 * Games fetched per page load. The reel loops this batch instead of fetching a
 * fresh game every few seconds, which used to keep the database awake for as
 * long as any tab sat on the home page.
 *
 * Raising this is cheap on the server: measured against production, the random
 * scan is 29ms for 20 rows and 59ms for 50, and the whole request is dominated
 * by connection warm-up either way. The only real cost is payload -- roughly
 * 1KB gzipped per game, so ~25KB here and ~60KB at 50, which is what delays the
 * first frame on a slow connection. 20 is already far past the point where a
 * visitor would notice the reel repeating.
 */
const SHOWCASE_BATCH_SIZE = 20;

export function GameShowcase({ flush = false }: { flush?: boolean }) {
  const [isPlaying, setIsPlaying] = useState(true);
  const [isTabVisible, setIsTabVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const [games, setGames] = useState<ShowcaseGame[] | null>(null);
  const [gameIndex, setGameIndex] = useState(0);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  // Autoplay stops while the tab is in the background: an unwatched reel should
  // not burn the visitor's battery, and it never needed to keep running.
  const isReelRunning = isPlaying && isTabVisible;

  useEffect(() => {
    const onVisibilityChange = () => setIsTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Hydrating replays the game, so only the one on screen is built.
  const showcase = useMemo(() => {
    const game = games?.[gameIndex];
    if (!game) return null;
    const config = buildGameConfigurationFromSerialized(game.state);
    return {
      matchStatus: game.matchStatus,
      state: game.state,
      gameState: hydrateGameStateFromSerialized(game.state, config),
    };
  }, [games, gameIndex]);

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

  const loadShowcaseGames = useCallback(async () => {
    if (isLoading) return;
    clearAllTimers();
    setIsLoading(true);
    setHasError(false);
    try {
      const data = await fetchShowcaseGames(SHOWCASE_BATCH_SIZE);
      setGames(data.games);
      setGameIndex(0);
      setHistoryCursor(-1);
    } catch (error) {
      console.error("[game-showcase] Failed to fetch showcase games", error);
      setGames(null);
      setHasError(true);
      setHistoryCursor(-1);
    } finally {
      setIsLoading(false);
    }
  }, [clearAllTimers, isLoading]);

  // One fetch per page load. Deliberately not gated on isReelRunning: a visitor
  // who arrives on a background tab should still find the reel ready.
  useEffect(() => {
    if (hasError || games || isLoading) return;
    void loadShowcaseGames();
  }, [hasError, games, isLoading, loadShowcaseGames]);

  useEffect(() => {
    clearTimer(autoplayTimeoutRef);
    clearTimer(endTimeoutRef);
    if (!isReelRunning || hasError || !showcase || !games) return;

    const maxIndex = showcase.gameState.history.length - 1;
    if (historyCursor < maxIndex) {
      autoplayTimeoutRef.current = setTimeout(() => {
        setHistoryCursor((prev) => Math.min(prev + 1, maxIndex));
      }, 200);
      return;
    }

    // Advance within the batch rather than hitting the network again.
    endTimeoutRef.current = setTimeout(() => {
      setGameIndex((prev) => (prev + 1) % games.length);
      setHistoryCursor(-1);
    }, 3000);
  }, [isReelRunning, hasError, showcase, games, historyCursor, clearTimer]);

  useEffect(() => {
    clearTimer(retryTimeoutRef);
    if (!isReelRunning || !hasError) return;
    retryTimeoutRef.current = setTimeout(() => {
      void loadShowcaseGames();
    }, 60000);
  }, [isReelRunning, hasError, loadShowcaseGames, clearTimer]);

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
    const usesClassicRules = isClassicVariant(displayState.config.variant);
    const playersById = new Map(
      showcase.matchStatus.players.map((player) => [player.playerId, player]),
    );

    return displayState.getPawns().map((pawn) => {
      const isClassicGoal = usesClassicRules && pawn.type === "mouse";
      const visualType = isClassicGoal ? "home" : pawn.type;
      // In Classic, homes display in the owning player's color (their destination)
      const visualPlayerId = pawn.playerId;
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

  const lastWalls = useMemo(() => {
    if (!displayState) return null;
    return computeLastWalls(displayState, playerColors);
  }, [displayState, playerColors]);

  const boardRows = displayState?.config.boardHeight ?? 8;
  const boardCols = displayState?.config.boardWidth ?? 8;

  // In flush mode, compute cell/gap sizes so the board fits the viewport width,
  // reusing the same logic as the mobile game page.
  const flushSizing = useMemo(() => {
    if (!flush) return undefined;
    const gapPx = 12;
    const refCols = Math.max(boardCols, 8);
    const availableW = typeof window !== "undefined" ? window.innerWidth : 390;
    const cellPx = Math.max(
      28,
      (availableW - (refCols - 1) * gapPx) / refCols,
    );
    return { gapSizeRem: gapPx / 16, maxCellSizeRem: cellPx / 16 };
  }, [flush, boardCols]);

  const orderedPlayers = useMemo(() => {
    if (!showcase) return [];
    return [...showcase.matchStatus.players].sort(
      (a, b) => a.playerId - b.playerId,
    );
  }, [showcase]);

  const title = useMemo(() => {
    if (!showcase || orderedPlayers.length < 2) return null;
    const formatPlayer = (player: GameSnapshot["players"][number]) => {
      const rating = player.elo != null ? ` (${Math.round(player.elo)})` : "";
      return `${player.displayName}${rating}`;
    };
    const players = `${formatPlayer(orderedPlayers[0])} vs ${formatPlayer(orderedPlayers[1])}`;
    if (flush) return `Showcase: ${players}`;
    const formatDate = (timestamp: number) =>
      new Date(timestamp).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      });
    return `Game showcase: ${players} (${formatDate(showcase.matchStatus.createdAt)})`;
  }, [showcase, orderedPlayers, flush]);

  const handleOpenReplay = useCallback(() => {
    if (!showcase) return;
    void navigate({
      to: `/game/${showcase.matchStatus.id}`,
      state: { replayPlyIndex: historyCursor },
    });
  }, [navigate, showcase, historyCursor]);

  const playPauseButton = (
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
  );

  if (flush) {
    return (
      <div onClick={handleOpenReplay} role="button" className="cursor-pointer max-w-full overflow-hidden">
        <Board
          rows={boardRows}
          cols={boardCols}
          pawns={boardPawns}
          walls={boardWalls}
          lastMoves={lastMoves ?? undefined}
          lastWalls={lastWalls ?? undefined}
          playerColors={playerColors}
          className="p-0"
          maxWidth="max-w-full"
          gapSizeRem={flushSizing?.gapSizeRem}
          maxCellSizeRem={flushSizing?.maxCellSizeRem}
          flush
        />
        <div className="flex items-center justify-between mt-2 px-4 gap-2 overflow-hidden">
          <div className="text-sm font-medium text-muted-foreground truncate min-w-0">
            {title ?? "Game showcase"}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              setIsPlaying((prev) => !prev);
            }}
          >
            {isPlaying ? (
              <><Pause className="h-3 w-3 mr-1" />Pause</>
            ) : (
              <><Play className="h-3 w-3 mr-1" />Play</>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card
      className="relative overflow-hidden bg-card border-2 border-border transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] cursor-pointer"
      onClick={handleOpenReplay}
      role="button"
    >
      <div className="p-3 sm:p-6">
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
          <div className="text-xs sm:text-sm font-medium text-muted-foreground truncate">
            {title ?? "Game showcase"}
          </div>
          {playPauseButton}
        </div>

        {/* Game Board */}
        <div className="w-full">
          <Board
            rows={boardRows}
            cols={boardCols}
            pawns={boardPawns}
            walls={boardWalls}
            lastMoves={lastMoves ?? undefined}
            lastWalls={lastWalls ?? undefined}
            playerColors={playerColors}
          />
        </div>
      </div>
    </Card>
  );
}
