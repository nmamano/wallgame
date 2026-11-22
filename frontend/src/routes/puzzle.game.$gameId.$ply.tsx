import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Board, type BoardPawn } from "@/components/board";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  fetchBots,
  fetchGamePositionPuzzle,
  launchPuzzle,
  userQueryOptions,
} from "@/lib/api";
import { saveGameHandshake } from "@/lib/game-session";
import { useSettings } from "@/hooks/use-settings";
import { computeLastMoves, computeLastWalls } from "@/lib/gameViewModel";
import {
  resolvePlayerColor,
  resolvePlayerColorPair,
} from "@/lib/player-colors";
import { normalizeBoardPawnStyle } from "@/lib/pawn-style";
import { GameState } from "../../../shared/domain/game-state";
import {
  BOT_GAME_TIME_CONTROL,
  pawnId,
} from "../../../shared/domain/game-utils";
import type {
  PlayerAppearance,
  PuzzleRef,
} from "../../../shared/domain/game-types";
import type { GamePositionPuzzle } from "../../../shared/contracts/puzzles";

/**
 * A position from a stored game, offered as a puzzle (task a03b8f5c). A daily
 * video stops on a win that a player missed and shows wallgame.io/go/<n>,
 * which leads here. The page shows the board exactly as the game will open on
 * it, and one tap starts the game against PuzzleBot. Any win counts.
 *
 * Opening the page starts nothing: only the button creates a game, so a link
 * preview or a crawler never does.
 */
export const Route = createFileRoute("/puzzle/game/$gameId/$ply")({
  component: GamePositionPuzzlePage,
});

/** The name the game page shows in its puzzle banner. */
const PUZZLE_NAME = "Find the win";

/** The board the launch opens on: its start position plus the bot's move. */
const openingState = (launch: GamePositionPuzzle["launch"]): GameState => {
  const state = new GameState(
    { ...launch.config, timeControl: BOT_GAME_TIME_CONTROL, rated: false },
    0,
  );
  return launch.leadInMove
    ? state.applyGameAction({
        kind: "move",
        move: launch.leadInMove,
        playerId: 1,
        timestamp: 0,
      })
    : state;
};

const skinOf = (look: PlayerAppearance, type: BoardPawn["type"]) =>
  normalizeBoardPawnStyle(
    type === "cat"
      ? look.catSkin
      : type === "mouse"
        ? look.mouseSkin
        : type === "dog"
          ? look.dogSkin
          : type === "elephant"
            ? look.elephantSkin
            : look.homeSkin,
  );

function GamePositionPuzzlePage() {
  const { gameId, ply: plyParam } = Route.useParams();
  const ply = Number(plyParam);
  const navigate = useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const settings = useSettings(!!userData?.user, userPending);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const puzzleQuery = useQuery({
    queryKey: ["game-position-puzzle", gameId, ply],
    queryFn: () => fetchGamePositionPuzzle(gameId, ply),
    enabled: Number.isInteger(ply),
    retry: false,
  });
  const puzzle = puzzleQuery.data;

  const view = useMemo(() => {
    if (!puzzle) return null;
    const state = openingState(puzzle.launch);
    const colors = resolvePlayerColorPair(
      resolvePlayerColor(puzzle.looks[1].pawnColor),
      resolvePlayerColor(puzzle.looks[2].pawnColor),
    );
    const pawns: BoardPawn[] = state.getPawns().map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
      pawnStyle: skinOf(puzzle.looks[pawn.playerId], pawn.type),
      visualPlayerId: pawn.playerId,
    }));
    const walls = state.grid
      .getWalls()
      .map((wall) => ({ ...wall, state: "placed" as const }));
    const solver = puzzle.launch.humanIsPlayer1 ? 1 : 2;
    return {
      state,
      colors,
      pawns,
      walls,
      solverColor: colors[solver],
      lastMoves: computeLastMoves(state, colors) ?? undefined,
      lastWalls: computeLastWalls(state, colors) ?? undefined,
    };
  }, [puzzle]);

  const handleSolve = async () => {
    if (!puzzle || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const { config } = puzzle.launch;
      const { bots } = await fetchBots({
        variant: config.variant,
        randomStart: false,
        boardWidth: config.boardWidth,
        boardHeight: config.boardHeight,
        placement: "puzzle",
      });
      // The puzzle bot, not merely one of ours - see use-puzzle-playback.ts.
      const bot = bots.find(
        (candidate) =>
          candidate.isAnalysisBot && candidate.placement === "puzzle",
      );
      if (!bot) {
        setLaunchError(
          "PuzzleBot is offline right now. Try again in a few minutes.",
        );
        setLaunching(false);
        return;
      }
      const ref: PuzzleRef = { kind: "game", gameId, ply };
      // No appearance: the server gives both seats the game's own look.
      const response = await launchPuzzle({
        botId: bot.id,
        ref,
        hostDisplayName: settings.displayName,
      });
      saveGameHandshake({
        gameId: response.gameId,
        token: response.token,
        socketToken: response.socketToken,
        role: response.role,
        playerId: response.playerId,
        shareUrl: response.shareUrl,
        puzzle: { ref, name: PUZZLE_NAME },
      });
      void navigate({ to: `/game/${response.gameId}`, replace: true });
    } catch (cause) {
      setLaunchError(
        cause instanceof Error ? cause.message : "Could not start the puzzle.",
      );
      setLaunching(false);
    }
  };

  const playFullGame = (
    <Button asChild variant="outline" className="h-11 w-full text-base">
      <Link to="/play">Play a full game</Link>
    </Button>
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 py-4">
      {puzzleQuery.isPending && Number.isInteger(ply) ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !view ? (
        <Card className="flex flex-col gap-3 p-4">
          <h1 className="text-lg font-bold">This puzzle is not available</h1>
          <p className="text-sm text-muted-foreground">
            The game or the position could not be found.
          </p>
          {playFullGame}
        </Card>
      ) : (
        <>
          <div className="text-center">
            <h1 className="text-2xl font-bold">{PUZZLE_NAME}</h1>
            <p className="text-sm text-muted-foreground">
              You play {view.solverColor}, and it is your move. Win the game
              against PuzzleBot: any win counts.
            </p>
          </div>
          <Board
            rows={view.state.config.boardHeight}
            cols={view.state.config.boardWidth}
            pawns={view.pawns}
            walls={view.walls}
            lastMoves={view.lastMoves}
            lastWalls={view.lastWalls}
            playerColors={view.colors}
            className="p-0"
            maxWidth="max-w-full"
          />
          <Button
            className="h-12 w-full text-lg"
            onClick={() => void handleSolve()}
            disabled={launching}
          >
            {launching ? "Starting…" : "Solve it"}
          </Button>
          {launchError && (
            <p className="text-center text-sm text-destructive">
              {launchError}
            </p>
          )}
          {playFullGame}
        </>
      )}
    </div>
  );
}
