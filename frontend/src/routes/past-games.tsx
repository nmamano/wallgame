import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
import { Eye } from "lucide-react";

export const Route = createFileRoute("/past-games")({
  component: PastGames,
});

function PastGames() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState({
    variant: "all",
    rated: "all",
    timeControl: "all",
    boardSize: "all",
    player1: "",
    player2: "",
    eloMin: "",
    eloMax: "",
  });

  // Mock data
  const games = [
    {
      id: "1",
      variant: "Standard",
      rated: true,
      timeControl: "rapid (10+2)",
      boardSize: "medium (8x8)",
      players: "Alice (1450) vs Bob (1420)",
      winner: "Alice",
      moves: 45,
      views: 127,
      date: "2025-01-10",
    },
    {
      id: "2",
      variant: "Standard",
      rated: false,
      timeControl: "blitz (3+2)",
      boardSize: "small (6x6)",
      players: "Charlie (1580) vs Diana (1590)",
      winner: "Draw",
      moves: 32,
      views: 89,
      date: "2025-01-09",
    },
    {
      id: "3",
      variant: "Classic",
      rated: true,
      timeControl: "rapid (10+2)",
      boardSize: "large (10x10)",
      players: "Eve (1720) vs Frank (1680)",
      winner: "Eve",
      moves: 61,
      views: 234,
      date: "2025-01-08",
    },
  ];

  const handleWatchGame = (gameId: string) => {
    void navigate({ to: `/game/${gameId}` });
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
        Past Games
      </h1>

      {/* Filters */}
      <Card className="p-6 mb-6 border-border/50 bg-card/50 backdrop-blur">
        <h2 className="text-2xl font-serif font-semibold mb-4 text-foreground">
          Filters
        </h2>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
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
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-foreground">Player 1</Label>
            <Input
              placeholder="Enter player name..."
              value={filters.player1}
              onChange={(e) =>
                setFilters({ ...filters, player1: e.target.value })
              }
              className="bg-background"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-foreground">Player 2</Label>
            <Input
              placeholder="Enter player name..."
              value={filters.player2}
              onChange={(e) =>
                setFilters({ ...filters, player2: e.target.value })
              }
              className="bg-background"
            />
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
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>Watch</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Rated</TableHead>
              <TableHead>Time Control</TableHead>
              <TableHead>Board Size</TableHead>
              <TableHead>Players</TableHead>
              <TableHead>Moves</TableHead>
              <TableHead>Views</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {games.map((game) => (
              <TableRow key={game.id} className="hover:bg-muted/20">
                <TableCell>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleWatchGame(game.id)}
                  >
                    <Eye className="w-4 h-4" />
                  </Button>
                </TableCell>
                <TableCell className="font-medium">{game.variant}</TableCell>
                <TableCell>
                  <Badge variant={game.rated ? "default" : "secondary"}>
                    {game.rated ? "Yes" : "No"}
                  </Badge>
                </TableCell>
                <TableCell>{game.timeControl}</TableCell>
                <TableCell>{game.boardSize}</TableCell>
                <TableCell>
                  <span
                    className={game.winner !== "Draw" ? "font-semibold" : ""}
                  >
                    {game.players}
                  </span>
                  {game.winner !== "Draw" && (
                    <Badge className="ml-2 text-xs" variant="secondary">
                      Winner: {game.winner}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{game.moves}</TableCell>
                <TableCell>{game.views}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {game.date}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
