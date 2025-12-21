import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Eye, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { PastGamesResponse } from "../../../shared/contracts/games";
import { presentPastGameRow } from "@/lib/past-games";

export const Route = createFileRoute("/past-games")({
  component: PastGames,
});

const PAGE_SIZE = 100;

interface Filters {
  variant: "all" | "standard" | "classic";
  rated: "all" | "yes" | "no";
  timeControl: "all" | "bullet" | "blitz" | "rapid" | "classical";
  boardSize: "all" | "small" | "medium" | "large";
  player1: string;
  player2: string;
  eloMin: string;
  eloMax: string;
}

const defaultFilters: Filters = {
  variant: "all",
  rated: "all",
  timeControl: "all",
  boardSize: "all",
  player1: "",
  player2: "",
  eloMin: "",
  eloMax: "",
};

const buildPastGamesQuery = (
  filters: Filters,
  page: number,
): Record<string, string | number> => {
  const query: Record<string, string | number> = {
    page,
    pageSize: PAGE_SIZE,
  };

  if (filters.variant !== "all") {
    query.variant = filters.variant;
  }
  if (filters.rated !== "all") {
    query.rated = filters.rated;
  }
  if (filters.timeControl !== "all") {
    query.timeControl = filters.timeControl;
  }
  if (filters.boardSize !== "all") {
    query.boardSize = filters.boardSize;
  }

  const minElo = Number.parseInt(filters.eloMin, 10);
  if (Number.isFinite(minElo) && minElo >= 0) {
    query.minElo = minElo;
  }
  const maxElo = Number.parseInt(filters.eloMax, 10);
  if (Number.isFinite(maxElo) && maxElo >= 0) {
    query.maxElo = maxElo;
  }

  const player1 = filters.player1.trim();
  if (player1) {
    query.player1 = player1;
  }
  const player2 = filters.player2.trim();
  if (player2) {
    query.player2 = player2;
  }

  return query;
};

const fetchPastGames = async (
  filters: Filters,
  page: number,
): Promise<PastGamesResponse> => {
  const query = buildPastGamesQuery(filters, page);
  const res = await api.games.past.$get({ query });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      data?.error ?? `Request failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<PastGamesResponse>;
};

function PastGames() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState<number>(1);

  const { data, isPending, error } = useQuery({
    queryKey: [
      "past-games",
      page,
      PAGE_SIZE,
      filters.variant,
      filters.rated,
      filters.timeControl,
      filters.boardSize,
      filters.player1,
      filters.player2,
      filters.eloMin,
      filters.eloMax,
    ],
    queryFn: () => fetchPastGames(filters, page),
  });

  const games = data?.games ?? [];
  const rows = games.map((game) => presentPastGameRow(game));
  const hasMore = data?.hasMore ?? false;

  const handleWatchGame = (gameId: string) => {
    void navigate({ to: `/game/${gameId}` });
  };

  const updateFilters = (next: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1);
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
                updateFilters({
                  variant: value as Filters["variant"],
                })
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
                updateFilters({
                  rated: value as Filters["rated"],
                })
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
                updateFilters({
                  timeControl: value as Filters["timeControl"],
                })
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
                updateFilters({
                  boardSize: value as Filters["boardSize"],
                })
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
                updateFilters({
                  player1: e.target.value,
                })
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
                updateFilters({
                  player2: e.target.value,
                })
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
                updateFilters({
                  eloMin: e.target.value,
                })
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
                updateFilters({
                  eloMax: e.target.value,
                })
              }
              className="bg-background"
            />
          </div>
        </div>
      </Card>

      {/* Games Table */}
      <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
        {isPending ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading past games...
          </div>
        ) : error ? (
          <div className="text-center py-12 text-destructive">
            {error.message}
          </div>
        ) : games.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No past games match your filters.
          </div>
        ) : (
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
              {rows.map((row) => {
                return (
                  <TableRow key={row.gameId} className="hover:bg-muted/20">
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleWatchGame(row.gameId)}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    </TableCell>
                    <TableCell className="font-medium capitalize">
                      {row.variant}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.rated ? "default" : "secondary"}>
                        {row.rated ? "Yes" : "No"}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.timeControlLabel}</TableCell>
                    <TableCell>{row.boardSizeLabel}</TableCell>
                    <TableCell>
                      <span className={row.winnerLabel ? "font-semibold" : ""}>
                        {row.playersLabel}
                      </span>
                      {row.winnerLabel && (
                        <Badge className="ml-2 text-xs" variant="secondary">
                          Winner: {row.winnerLabel}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{row.movesCount}</TableCell>
                    <TableCell>{row.views}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.dateLabel}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border/40">
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPage((prev) => prev + 1)}
              disabled={!hasMore}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
