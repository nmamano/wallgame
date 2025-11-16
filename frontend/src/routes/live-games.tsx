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
import { Eye, Users } from "lucide-react";

export const Route = createFileRoute("/live-games")({
  component: LiveGames,
});

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

  // Mock data
  const games = [
    {
      id: "live-1",
      variant: "Standard",
      rated: true,
      timeControl: "rapid (10+2)",
      boardSize: "medium (8x8)",
      players: "GrandMaster (1850) vs ProPlayer (1820)",
      moves: 23,
      viewers: 156,
      maxElo: 1850,
    },
    {
      id: "live-2",
      variant: "Standard",
      rated: true,
      timeControl: "blitz (3+2)",
      boardSize: "small (6x6)",
      players: "Alice (1450) vs Bob (1460)",
      moves: 15,
      viewers: 42,
      maxElo: 1460,
    },
    {
      id: "live-3",
      variant: "Classic",
      rated: false,
      timeControl: "rapid (10+2)",
      boardSize: "large (10x10)",
      players: "Charlie (1320) vs Diana (1280)",
      moves: 8,
      viewers: 18,
      maxElo: 1320,
    },
  ];

  const handleWatchGame = (gameId: string) => {
    navigate({ to: `/game/${gameId}` });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        <div className="flex items-center gap-3 mb-8">
          <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground text-balance">
            Live Games
          </h1>
          <Badge className="px-3 py-1 bg-red-600 dark:bg-red-700 animate-pulse">
            LIVE
          </Badge>
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
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="large">Large</SelectItem>
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
              {games.map((game) => (
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
                      <span className="font-semibold">{game.viewers}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{game.variant}</TableCell>
                  <TableCell>
                    <Badge variant={game.rated ? "default" : "secondary"}>
                      {game.rated ? "Yes" : "No"}
                    </Badge>
                  </TableCell>
                  <TableCell>{game.timeControl}</TableCell>
                  <TableCell>{game.boardSize}</TableCell>
                  <TableCell>{game.players}</TableCell>
                  <TableCell>{game.moves}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
