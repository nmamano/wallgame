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
import { Trophy, Medal, Award, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  type PastGamesFiltersState,
  type PastGamesNavState,
} from "@/lib/navigation-state";
import type {
  RankingResponse,
  RankingRow,
} from "../../../shared/contracts/ranking";

export const Route = createFileRoute("/ranking")({
  component: Ranking,
});

const PAGE_SIZE = 100;
type RankingQuery = Parameters<typeof api.ranking.$get>[0]["query"];

interface RankingFilters {
  variant: "standard" | "classic";
  timeControl: "bullet" | "blitz" | "rapid" | "classical";
  player: string;
}

const buildRankingQuery = (
  filters: RankingFilters,
  page: number,
): RankingQuery => {
  const player = filters.player.trim().toLowerCase();
  return {
    variant: filters.variant,
    timeControl: filters.timeControl,
    page: String(page),
    pageSize: String(PAGE_SIZE),
    ...(player ? { player } : {}),
  };
};

const fetchRanking = async (
  filters: RankingFilters,
  page: number,
): Promise<RankingResponse> => {
  const query = buildRankingQuery(filters, page);
  const res = await api.ranking.$get({ query });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      data?.error ?? `Request failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<RankingResponse>;
};

const formatNumber = (value: number): string => {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
};

const formatRecord = (row: RankingRow): string => {
  return `${formatNumber(row.recordWins)}-${formatNumber(row.recordLosses)}`;
};

const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
};

function Ranking() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState<RankingFilters>({
    variant: "standard",
    timeControl: "rapid",
    player: "",
  });
  const [page, setPage] = useState<number>(1);

  const { data, isPending, error } = useQuery({
    queryKey: [
      "ranking",
      page,
      PAGE_SIZE,
      filters.variant,
      filters.timeControl,
      filters.player,
    ],
    queryFn: () => fetchRanking(filters, page),
  });

  const rankings = data?.rows ?? [];
  const hasMore = data?.hasMore ?? false;
  const resolvedPage = data?.page ?? page;
  const hasPlayerSearch = filters.player.trim().length > 0;

  const updateFilters = (next: Partial<RankingFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1);
  };

  const handleRowClick = (row: RankingRow) => {
    const pastGamesFilters: PastGamesFiltersState = {
      variant: filters.variant,
      timeControl: filters.timeControl,
      rated: "yes",
      player1: row.displayName,
    };
    const navState: PastGamesNavState = { pastGamesFilters };
    void navigate({
      to: "/past-games",
      state: navState,
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
                  updateFilters({ variant: value as RankingFilters["variant"] })
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
                  updateFilters({
                    timeControl: value as RankingFilters["timeControl"],
                  })
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
                onChange={(e) => updateFilters({ player: e.target.value })}
                className="bg-background"
              />
            </div>
          </div>
        </Card>

        {/* Rankings Table */}
        <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
          {isPending ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading rankings...
            </div>
          ) : error ? (
            <div className="text-center py-12 text-destructive">
              {error.message}
            </div>
          ) : rankings.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {hasPlayerSearch
                ? "No player found for that search."
                : "No ranking data available for these filters."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>Rank</TableHead>
                  <TableHead>Player</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Peak Rating</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Join Date</TableHead>
                  <TableHead>Last Game</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rankings.map((ranking) => (
                  <TableRow
                    key={ranking.rank}
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={() => handleRowClick(ranking)}
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
                      {ranking.displayLabel}
                    </TableCell>
                    <TableCell className="font-bold text-lg">
                      {Math.round(ranking.rating)}
                    </TableCell>
                    <TableCell className="text-muted-foreground/70">
                      {Math.round(ranking.peakRating)}
                    </TableCell>
                    <TableCell>{formatRecord(ranking)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground/70">
                      {formatDate(ranking.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground/70">
                      {formatDate(ranking.lastGameAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex items-center justify-between px-4 py-3 border-t border-border/40">
            <span className="text-sm text-muted-foreground">
              Page {resolvedPage}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={hasPlayerSearch || page <= 1}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPage((prev) => prev + 1)}
                disabled={hasPlayerSearch || !hasMore}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
