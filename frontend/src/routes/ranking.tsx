import {
  createFileRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { useMediaQuery } from "@/hooks/use-media-query";
import { api } from "@/lib/api";
import {
  type PastGamesFiltersState,
  type PastGamesNavState,
  parseRankingNavState,
} from "@/lib/navigation-state";
import type {
  RankingResponse,
  RankingRow,
} from "../../../shared/contracts/ranking";
import { useLocalStorageState } from "@/hooks/use-local-storage";
import { messageFromApiErrorBody } from "@/lib/api-error";

export const Route = createFileRoute("/ranking")({
  component: Ranking,
});

const PAGE_SIZE = 100;
const FILTERS_STORAGE_KEY = "ranking_filters";
type RankingQuery = Parameters<typeof api.ranking.$get>[0]["query"];

interface RankingFilters {
  /** "all" is the global rating, across every variant AND time control. */
  variant: "all" | "standard" | "animal-cycle" | "classic";
  timeControl: "bullet" | "blitz" | "rapid" | "classical";
  player: string;
}

const defaultFilters: RankingFilters = {
  variant: "all",
  timeControl: "rapid",
  player: "",
};

const buildRankingQuery = (
  filters: RankingFilters,
  page: number,
): RankingQuery => {
  const player = filters.player.trim().toLowerCase();
  const pagination = {
    page: String(page),
    pageSize: String(PAGE_SIZE),
    ...(player ? { player } : {}),
  };
  // The server rejects unknown keys, so a global request must not carry a time
  // control - it names nothing that is stored.
  return filters.variant === "all"
    ? { scope: "global", ...pagination }
    : {
        scope: "variant",
        variant: filters.variant,
        timeControl: filters.timeControl,
        ...pagination,
      };
};

const fetchRanking = async (
  filters: RankingFilters,
  page: number,
): Promise<RankingResponse> => {
  const query = buildRankingQuery(filters, page);
  const res = await api.ranking.$get({ query });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw new Error(messageFromApiErrorBody(data, res.status, res.statusText));
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
  const router = useRouterState();
  const isSmallScreen = useMediaQuery("(max-width: 639px)");
  const Wrapper = isSmallScreen ? "div" : Card;

  const initialFilters = useMemo(
    () => parseRankingNavState(router.location.state) ?? {},
    [router.location.state],
  );

  const [filters, setFilters] = useLocalStorageState<RankingFilters>(
    FILTERS_STORAGE_KEY,
    () => ({
      ...defaultFilters,
      ...initialFilters,
    }),
  );
  const [page, setPage] = useState<number>(1);

  useEffect(() => {
    if (Object.keys(initialFilters).length === 0) return;
    setFilters((previous) => ({ ...previous, ...initialFilters }));
  }, [initialFilters, setFilters]);

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
  const isGlobal = filters.variant === "all";

  const updateFilters = (next: Partial<RankingFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1);
  };

  const handleRowClick = (row: RankingRow) => {
    // In global mode the row summarises every variant and time control, so
    // carrying either into past-games would filter away most of what it counts.
    const pastGamesFilters: PastGamesFiltersState = isGlobal
      ? {
          variant: "all",
          timeControl: "all",
          rated: "yes",
          player1: row.displayName,
        }
      : {
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
      <div
        className={isSmallScreen ? "py-4 px-3" : "container mx-auto py-8 px-4"}
      >
        <h1 className="text-2xl sm:text-4xl font-serif font-bold tracking-tight text-foreground mb-4 sm:mb-8 text-balance">
          Ranking
        </h1>

        {/* Filters */}
        <Wrapper
          className={
            isSmallScreen
              ? "mb-4"
              : "p-6 mb-6 border-border/50 bg-card/50 backdrop-blur"
          }
        >
          <h2 className="text-lg sm:text-2xl font-serif font-semibold mb-3 sm:mb-4 text-foreground">
            Filters
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
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
                  <SelectItem value="all">All variants</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="animal-cycle">Animal Cycle</SelectItem>
                  <SelectItem value="classic">Classic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Hidden rather than disabled when the ranking is global: the
                global rating spans time controls, so there is no value here
                that would mean anything, and a greyed-out "Rapid" would read
                as if it still applied. */}
            {!isGlobal && (
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
            )}

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
        </Wrapper>

        {/* Rankings Table */}
        <Wrapper
          className={
            isSmallScreen
              ? "overflow-x-auto -mx-3"
              : "overflow-hidden border-border/50 bg-card/50 backdrop-blur"
          }
        >
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
              {isPending ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <div className="flex items-center justify-center text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin mr-2" />
                      Loading rankings...
                    </div>
                  </TableCell>
                </TableRow>
              ) : error ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-12 text-center text-destructive"
                  >
                    {error.message}
                  </TableCell>
                </TableRow>
              ) : rankings.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-12 text-center text-muted-foreground"
                  >
                    {hasPlayerSearch
                      ? "No player found for that search."
                      : "No ranking data available for these filters."}
                  </TableCell>
                </TableRow>
              ) : (
                rankings.map((ranking) => (
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
                      <span className="inline-flex items-baseline gap-1.5">
                        {Math.round(ranking.rating)}
                        {ranking.provisional && (
                          <span
                            className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground"
                            title="Provisional: too few games for a confident rating"
                          >
                            prov
                          </span>
                        )}
                      </span>
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
                ))
              )}
            </TableBody>
          </Table>
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
        </Wrapper>
      </div>
    </div>
  );
}
