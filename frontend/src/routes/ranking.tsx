import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
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
import { Trophy, Medal, Award } from "lucide-react";

export const Route = createFileRoute("/ranking")({
  component: Ranking,
});

function Ranking() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState({
    variant: "standard",
    timeControl: "rapid",
    player: "",
  });

  // Mock data
  const rankings = [
    {
      rank: 1,
      player: "GrandMaster",
      rating: 1850,
      peakRating: 1890,
      record: "127-43",
      firstGame: "2024-03-15",
      lastGame: "2025-01-15",
    },
    {
      rank: 2,
      player: "ProPlayer",
      rating: 1820,
      peakRating: 1825,
      record: "98-52",
      firstGame: "2024-05-20",
      lastGame: "2025-01-14",
    },
    {
      rank: 3,
      player: "ChessKnight",
      rating: 1785,
      peakRating: 1800,
      record: "142-68",
      firstGame: "2024-01-10",
      lastGame: "2025-01-13",
    },
    {
      rank: 4,
      player: "Alice",
      rating: 1450,
      peakRating: 1520,
      record: "65-45",
      firstGame: "2024-08-01",
      lastGame: "2025-01-10",
    },
    {
      rank: 5,
      player: "Bob",
      rating: 1420,
      peakRating: 1480,
      record: "54-48",
      firstGame: "2024-09-15",
      lastGame: "2025-01-09",
    },
  ];

  const handleRowClick = (player: string) => {
    void navigate({
      to: "/past-games",
      search: {
        variant: filters.variant,
        timeControl: filters.timeControl,
        player,
        rated: "yes",
      },
    });
  };

  const getRankIcon = (rank: number) => {
    if (rank === 1)
      return (
        <Trophy className="w-5 h-5 text-yellow-600 dark:text-yellow-500" />
      );
    if (rank === 2)
      return <Medal className="w-5 h-5 text-gray-400 dark:text-gray-500" />;
    if (rank === 3)
      return <Award className="w-5 h-5 text-amber-700 dark:text-amber-600" />;
    return null;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
          Ranking
        </h1>

        {/* Filters */}
        <Card className="p-6 mb-6 border-border/50 bg-card/50 backdrop-blur">
          <h2 className="text-2xl font-serif font-semibold mb-4 text-foreground">
            Filters
          </h2>

          <div className="grid md:grid-cols-3 gap-4">
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
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="classic">Classic</SelectItem>
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
                  <SelectItem value="bullet">Bullet</SelectItem>
                  <SelectItem value="blitz">Blitz</SelectItem>
                  <SelectItem value="rapid">Rapid</SelectItem>
                  <SelectItem value="classical">Classical</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-foreground">Search Player</Label>
              <Input
                placeholder="Enter player name..."
                value={filters.player}
                onChange={(e) =>
                  setFilters({ ...filters, player: e.target.value })
                }
                className="bg-background"
              />
            </div>
          </div>
        </Card>

        {/* Rankings Table */}
        <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Rank</TableHead>
                <TableHead>Player</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Peak Rating</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>First Game</TableHead>
                <TableHead>Last Game</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rankings.map((ranking) => (
                <TableRow
                  key={ranking.rank}
                  className="hover:bg-muted/30 cursor-pointer"
                  onClick={() => handleRowClick(ranking.player)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {getRankIcon(ranking.rank)}
                      <span className="font-bold text-foreground">
                        {ranking.rank}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="font-semibold text-foreground">
                    {ranking.player}
                  </TableCell>
                  <TableCell className="font-bold text-lg">
                    {ranking.rating}
                  </TableCell>
                  <TableCell className="text-muted-foreground/70">
                    {ranking.peakRating}
                  </TableCell>
                  <TableCell>{ranking.record}</TableCell>
                  <TableCell className="text-sm text-muted-foreground/70">
                    {ranking.firstGame}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground/70">
                    {ranking.lastGame}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
