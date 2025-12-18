import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Eye, Users, Loader2 } from "lucide-react";
import type { LiveGameSummary } from "../../../shared/contracts/games";
import type { LiveGamesServerMessage } from "../../../shared/contracts/websocket-messages";

export const Route = createFileRoute("/live-games")({
  component: LiveGames,
});

function formatTimeControl(game: LiveGameSummary): string {
  const preset = game.timeControl.preset ?? "custom";
  const initial = Math.floor(game.timeControl.initialSeconds / 60);
  const increment = game.timeControl.incrementSeconds;
  return `${preset} (${initial}+${increment})`;
}

function formatBoardSize(game: LiveGameSummary): string {
  const size = game.boardWidth;
  if (size <= 6) return `small (${size}x${size})`;
  if (size <= 8) return `medium (${size}x${size})`;
  return `large (${size}x${size})`;
}

function formatPlayers(game: LiveGameSummary): string {
  return game.players
    .map((p) => `${p.displayName} (${p.elo ?? "?"})`)
    .join(" vs ");
}

function getDisplayedMoveCount(game: LiveGameSummary): number {
  // Server moveCount is 1-based (starts at 1 before any moves); subtract 1 for completed moves
  return Math.max(0, game.moveCount - 1);
}

function LiveGames() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState({
    variant: "all",
    rated: "all",
    timeControl: "all",
    boardSize: "all",
    eloMin: "",
    eloMax: "",
  });

  const [games, setGames] = useState<LiveGameSummary[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const url = new URL(window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/live-games";

    const ws = new WebSocket(url.toString());
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setIsConnected(true);
      setError(null);
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string) as LiveGamesServerMessage;

        if (msg.type === "snapshot") {
          setGames(msg.games);
        } else if (msg.type === "upsert") {
          setGames((prev) => {
            const idx = prev.findIndex((g) => g.id === msg.game.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = msg.game;
              return next;
            }
            return [...prev, msg.game];
          });
        } else if (msg.type === "remove") {
          setGames((prev) => prev.filter((g) => g.id !== msg.gameId));
        }
      } catch (err) {
        console.error("Failed to parse live games message", err);
      }
    });

    ws.addEventListener("close", () => {
      setIsConnected(false);
    });

    ws.addEventListener("error", () => {
      setError("Connection error. Retrying...");
    });

    // Ping to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
      ws.close();
    };
  }, []);

  // Filter games client-side
  const filteredGames = useMemo(() => {
    return games
      .filter((game) => {
        if (filters.variant !== "all" && game.variant !== filters.variant)
          return false;
        if (filters.rated !== "all") {
          const wantRated = filters.rated === "yes";
          if (game.rated !== wantRated) return false;
        }
        if (
          filters.timeControl !== "all" &&
          game.timeControl.preset !== filters.timeControl
        )
          return false;
        if (filters.boardSize !== "all") {
          const size = game.boardWidth;
          if (filters.boardSize === "small" && size > 6) return false;
          if (filters.boardSize === "medium" && (size <= 6 || size > 8))
            return false;
          if (filters.boardSize === "large" && size <= 8) return false;
        }
        if (filters.eloMin) {
          const min = parseInt(filters.eloMin, 10);
          if (!isNaN(min) && game.averageElo < min) return false;
        }
        if (filters.eloMax) {
          const max = parseInt(filters.eloMax, 10);
          if (!isNaN(max) && game.averageElo > max) return false;
        }
        return true;
      })
      .sort(
        (a, b) => b.averageElo - a.averageElo || b.lastMoveAt - a.lastMoveAt,
      );
  }, [games, filters]);

  const handleWatchGame = (gameId: string) => {
    void navigate({ to: `/game/${gameId}` });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        <div className="flex items-center gap-3 mb-8">
          <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground text-balance">
            Live Games
          </h1>
          <Badge
            className={`px-3 py-1 ${isConnected ? "bg-red-600 dark:bg-red-700 animate-pulse" : "bg-gray-500"}`}
          >
            {isConnected ? "LIVE" : "CONNECTING..."}
          </Badge>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>

        {/* Filters */}
        <Card className="p-6 mb-6 border-border/50 bg-card/50 backdrop-blur">
          <h2 className="text-2xl font-serif font-semibold mb-4 text-foreground">
            Filters
          </h2>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-foreground">Variant</Label>
              <Select
                value={filters.variant}
                onValueChange={(value) =>
                  setFilters({ ...filters, variant: value })
                }
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="classic">Classic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-foreground">Rated</Label>
              <Select
                value={filters.rated}
                onValueChange={(value) =>
                  setFilters({ ...filters, rated: value })
                }
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-foreground">Time Control</Label>
              <Select
                value={filters.timeControl}
                onValueChange={(value) =>
                  setFilters({ ...filters, timeControl: value })
                }
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="bullet">Bullet</SelectItem>
                  <SelectItem value="blitz">Blitz</SelectItem>
                  <SelectItem value="rapid">Rapid</SelectItem>
                  <SelectItem value="classical">Classical</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-foreground">Board Size</Label>
              <Select
                value={filters.boardSize}
                onValueChange={(value) =>
                  setFilters({ ...filters, boardSize: value })
                }
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="small">Small (≤6)</SelectItem>
                  <SelectItem value="medium">Medium (7-8)</SelectItem>
                  <SelectItem value="large">Large (≥9)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-foreground">Min ELO</Label>
              <Input
                type="number"
                placeholder="e.g., 1200"
                value={filters.eloMin}
                onChange={(e) =>
                  setFilters({ ...filters, eloMin: e.target.value })
                }
                className="bg-background"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-foreground">Max ELO</Label>
              <Input
                type="number"
                placeholder="e.g., 2000"
                value={filters.eloMax}
                onChange={(e) =>
                  setFilters({ ...filters, eloMax: e.target.value })
                }
                className="bg-background"
              />
            </div>
          </div>
        </Card>

        {/* Games Table */}
        <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
          {!isConnected && games.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mr-2" />
              <span className="text-muted-foreground">
                Loading live games...
              </span>
            </div>
          ) : filteredGames.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {games.length === 0
                ? "No live games at the moment. Check back later!"
                : "No games match your filters."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Watch</TableHead>
                  <TableHead>Viewers</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead>Rated</TableHead>
                  <TableHead>Time Control</TableHead>
                  <TableHead>Board Size</TableHead>
                  <TableHead>Players</TableHead>
                  <TableHead>Moves</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredGames.map((game) => (
                  <TableRow key={game.id} className="hover:bg-muted/30">
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleWatchGame(game.id)}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-amber-700 dark:text-amber-300" />
                        <span className="font-semibold">
                          {game.spectatorCount}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium capitalize">
                      {game.variant}
                    </TableCell>
                    <TableCell>
                      <Badge variant={game.rated ? "default" : "secondary"}>
                        {game.rated ? "Yes" : "No"}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatTimeControl(game)}</TableCell>
                    <TableCell>{formatBoardSize(game)}</TableCell>
                    <TableCell>{formatPlayers(game)}</TableCell>
                    <TableCell>{getDisplayedMoveCount(game)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
