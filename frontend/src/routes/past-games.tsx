import { createFileRoute, Link, useRouterState } from "@tanstack/react-router";
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
import { Badge } from "@/components/ui/badge";
import { BarChart3, Crown, Eye, List, Loader2 } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { api } from "@/lib/api";
import type {
  PastGamesActivityResponse,
  PastGamesResponse,
} from "../../../shared/contracts/games";
import {
  buildPastGamesFilterQuery,
  defaultPastGamesFilters,
  pastGamesFilterKey,
  presentPastGameRow,
  type PastGamesFilters as Filters,
} from "@/lib/past-games";
import { PastGamesActivityChart } from "@/components/past-games-activity-chart";
import { PastGamePlayerToken } from "@/components/past-game-player-token";
import { parsePastGamesNavState } from "@/lib/navigation-state";
import { useLocalStorageState } from "@/hooks/use-local-storage";
import { messageFromApiErrorBody } from "@/lib/api-error";

export const Route = createFileRoute("/past-games")({
  component: PastGames,
});

const PAGE_SIZE = 100;
const FILTERS_STORAGE_KEY = "past_games_filters";

type ViewMode = "list" | "plot";

const readError = async (res: Response): Promise<never> => {
  const data: unknown = await res.json().catch(() => null);
  throw new Error(messageFromApiErrorBody(data, res.status, res.statusText));
};

const fetchPastGames = async (
  filters: Filters,
  page: number,
): Promise<PastGamesResponse> => {
  const res = await api.games.past.$get({
    query: {
      ...buildPastGamesFilterQuery(filters),
      page: String(page),
      pageSize: String(PAGE_SIZE),
    },
  });
  if (!res.ok) {
    await readError(res);
  }
  return res.json() as Promise<PastGamesResponse>;
};

const fetchPastGamesActivity = async (
  filters: Filters,
): Promise<PastGamesActivityResponse> => {
  const res = await api.games.past.activity.$get({
    query: {
      ...buildPastGamesFilterQuery(filters),
      // The plot's days are the reader's days, so they are bucketed in the
      // reader's zone - the list beside it already prints local timestamps.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
  if (!res.ok) {
    await readError(res);
  }
  return res.json() as Promise<PastGamesActivityResponse>;
};

function PastGames() {
  const router = useRouterState();
  const isSmallScreen = useMediaQuery("(max-width: 639px)");
  const Wrapper = isSmallScreen ? "div" : Card;

  const initialFilters = useMemo(
    () => parsePastGamesNavState(router.location.state) ?? {},
    [router.location.state],
  );

  const [filters, setFilters] = useLocalStorageState<Filters>(
    FILTERS_STORAGE_KEY,
    () => ({
      ...defaultPastGamesFilters,
      ...initialFilters,
    }),
  );
  const [page, setPage] = useState<number>(1);

  useEffect(() => {
    if (Object.keys(initialFilters).length === 0) return;
    setFilters((previous) => ({ ...previous, ...initialFilters }));
  }, [initialFilters, setFilters]);
  const [view, setView] = useState<ViewMode>("list");

  const filterKey = pastGamesFilterKey(filters);

  const { data, isPending, error } = useQuery({
    queryKey: ["past-games", page, PAGE_SIZE, ...filterKey],
    queryFn: () => fetchPastGames(filters, page),
    enabled: view === "list",
  });

  const activity = useQuery({
    queryKey: ["past-games-activity", ...filterKey],
    queryFn: () => fetchPastGamesActivity(filters),
    enabled: view === "plot",
  });

  const games = data?.games ?? [];
  const rows = games.map((game) => presentPastGameRow(game));
  const hasMore = data?.hasMore ?? false;

  const updateFilters = (next: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1);
  };

  return (
    <div className="min-h-screen bg-background">
      <div
        className={isSmallScreen ? "py-4 px-3" : "container mx-auto py-8 px-4"}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 sm:mb-8">
          <h1 className="text-2xl sm:text-4xl font-serif font-bold tracking-tight text-foreground text-balance">
            Past Games
          </h1>
          <div
            className="inline-flex rounded-md border border-border/60 p-0.5"
            role="group"
            aria-label="View mode"
          >
            {(
              [
                { mode: "list", label: "List", Icon: List },
                { mode: "plot", label: "Plot", Icon: BarChart3 },
              ] as const
            ).map(({ mode, label, Icon }) => (
              <Button
                key={mode}
                size="sm"
                variant={view === mode ? "secondary" : "ghost"}
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                <Icon className="w-4 h-4 mr-1.5" />
                {label}
              </Button>
            ))}
          </div>
        </div>

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

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
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
                  <SelectItem value="animal-cycle">Animal Cycle</SelectItem>
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
        </Wrapper>

        {/* Activity plot - the same filtered games, counted per day */}
        {view === "plot" ? (
          <Wrapper
            className={
              isSmallScreen
                ? ""
                : "p-6 border-border/50 bg-card/50 backdrop-blur"
            }
          >
            <PastGamesActivityChart
              days={activity.data?.days ?? []}
              total={activity.data?.total ?? 0}
              isPending={activity.isPending}
              error={activity.error}
            />
          </Wrapper>
        ) : (
          <Wrapper
            className={
              isSmallScreen
                ? "overflow-x-auto -mx-3"
                : "overflow-hidden border-border/50 bg-card/50 backdrop-blur"
            }
          >
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead>Watch</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead>Rated</TableHead>
                  <TableHead>Time Control</TableHead>
                  <TableHead>Players</TableHead>
                  <TableHead>Moves</TableHead>
                  <TableHead>Views</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12 text-center">
                      <div className="flex items-center justify-center text-muted-foreground">
                        <Loader2 className="w-5 h-5 animate-spin mr-2" />
                        Loading past games...
                      </div>
                    </TableCell>
                  </TableRow>
                ) : error ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-12 text-center text-destructive"
                    >
                      {error.message}
                    </TableCell>
                  </TableRow>
                ) : games.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-12 text-center text-muted-foreground"
                    >
                      No past games match your filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.gameId} className="hover:bg-muted/20">
                      <TableCell>
                        <Button asChild size="sm" variant="ghost">
                          <Link
                            to="/game/$id"
                            params={{ id: row.gameId }}
                            aria-label={`Watch game ${row.gameId}`}
                          >
                            <Eye className="w-4 h-4" />
                          </Link>
                        </Button>
                      </TableCell>
                      <TableCell className="font-medium whitespace-nowrap">
                        {row.variantLabel}
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.rated ? "default" : "secondary"}>
                          {row.rated ? "Yes" : "No"}
                        </Badge>
                      </TableCell>
                      <TableCell>{row.timeControlLabel}</TableCell>
                      <TableCell>
                        {row.players.map((player, index) => (
                          <span key={`${row.gameId}-player-${index}`}>
                            {index > 0 && (
                              <span className="mx-1 text-muted-foreground">
                                vs
                              </span>
                            )}
                            <PastGamePlayerToken kind={player.kind}>
                              <span
                                className={
                                  player.isWinner
                                    ? "font-semibold whitespace-nowrap"
                                    : "whitespace-nowrap"
                                }
                              >
                                {player.isWinner && (
                                  <Crown
                                    className="inline-block w-3.5 h-3.5 mr-1 -mt-0.5 text-amber-500"
                                    aria-label="Winner"
                                  />
                                )}
                                {player.label}
                              </span>
                            </PastGamePlayerToken>
                          </span>
                        ))}
                      </TableCell>
                      <TableCell>{row.movesCount}</TableCell>
                      <TableCell>{row.views}</TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {row.dateLabel}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
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
          </Wrapper>
        )}
      </div>
    </div>
  );
}
