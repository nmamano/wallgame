import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, settingsQueryOptions, userQueryOptions } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type {
  RankingResponse,
  RankingRow,
} from "../../../shared/contracts/ranking";

export const Route = createFileRoute("/profile")({
  component: Profile,
});

type RankingQuery = Parameters<typeof api.ranking.$get>[0]["query"];

const fetchUserRankingRow = async (args: {
  variant: RankingQuery["variant"];
  timeControl: RankingQuery["timeControl"];
  player: string;
}): Promise<RankingRow | null> => {
  const res = await api.ranking.$get({
    query: {
      variant: args.variant,
      timeControl: args.timeControl,
      page: "1",
      pageSize: "1",
      player: args.player,
    },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      data?.error ?? `Request failed: ${res.status} ${res.statusText}`,
    );
  }
  const data = (await res.json()) as RankingResponse;
  return data.rows[0] ?? null;
};

const LoginLayout = () => {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        <div className="max-w-xl mx-auto space-y-6">
          <div className="space-y-2">
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground text-balance">
              Login
            </h1>
            <p className="text-lg text-muted-foreground">
              Log in or sign up to choose a name, play rated games, and see your
              game history.
            </p>
          </div>
          <Card className="p-6 border-border/50 bg-card/50 backdrop-blur">
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <a href="/api/login">Log in</a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="w-full sm:w-auto"
              >
                <a href="/api/register">Sign up</a>
              </Button>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
};

function Profile() {
  const navigate = useNavigate();
  const {
    isPending: userPending,
    error: userError,
    data: userData,
  } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;

  const {
    data: settingsData,
    isPending: settingsPending,
    error: settingsError,
  } = useQuery({
    ...settingsQueryOptions,
    enabled: isLoggedIn && !userPending,
  });

  const displayName = settingsPending
    ? "Loading..."
    : (settingsData?.capitalizedDisplayName ??
      settingsData?.displayName ??
      "Player");
  const displayNameFilter = settingsData?.displayName ?? "";
  const canFilterByName = displayNameFilter.length > 0;

  const variant: RankingQuery["variant"] =
    settingsData?.defaultVariant ?? "standard";
  const timeControl: RankingQuery["timeControl"] =
    settingsData?.defaultTimeControl ?? "rapid";

  const {
    data: ratingRow,
    isPending: ratingPending,
    error: ratingError,
  } = useQuery({
    queryKey: ["profile-rating", displayNameFilter, variant, timeControl],
    enabled: isLoggedIn && canFilterByName && !settingsPending,
    queryFn: () =>
      fetchUserRankingRow({
        variant,
        timeControl,
        player: displayNameFilter,
      }),
  });

  if (userPending) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-12 text-muted-foreground">
          Loading profile...
        </div>
      </div>
    );
  }

  if (userError) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-12 text-destructive">
          {userError.message}
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return <LoginLayout />;
  }

  const ratingValue = ratingRow ? Math.round(ratingRow.rating) : null;
  const ratingIsLoading = settingsPending || ratingPending;
  const ratingText = ratingIsLoading
    ? "Loading..."
    : settingsError || ratingError
      ? "Unavailable"
      : (ratingValue ?? "Unrated");

  const handlePastGames = () => {
    if (!canFilterByName) return;
    void navigate({
      to: "/past-games",
      state: {
        pastGamesFilters: {
          player1: displayName,
        },
      },
    });
  };

  const handleRanking = () => {
    if (!canFilterByName) return;
    void navigate({
      to: "/ranking",
      state: {
        rankingFilters: {
          player: displayName,
        },
      },
    });
  };

  const handleSettings = () => {
    void navigate({ to: "/settings" });
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        <div className="max-w-3xl mx-auto space-y-8">
          <div className="space-y-2">
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground text-balance">
              Profile
            </h1>
            <p className="text-lg text-muted-foreground">
              Manage your account and activity
            </p>
          </div>

          {settingsError && (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load profile details.{" "}
                {settingsError instanceof Error
                  ? settingsError.message
                  : String(settingsError)}
              </AlertDescription>
            </Alert>
          )}

          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardContent className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Display Name</p>
                <p className="text-2xl font-serif font-semibold text-foreground">
                  {displayName}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Rating</p>
                <div className="flex items-center gap-2 text-2xl font-semibold text-foreground">
                  {ratingIsLoading && (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  )}
                  <span>{ratingText}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">Your Activity</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Button
                variant="outline"
                onClick={handlePastGames}
                disabled={!canFilterByName || settingsPending}
              >
                Past Games
              </Button>
              <Button
                variant="outline"
                onClick={handleRanking}
                disabled={!canFilterByName || settingsPending}
              >
                Ranking
              </Button>
              <Button variant="outline" onClick={handleSettings}>
                Settings
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">Account</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Button variant="outline" asChild>
                <a href="/api/logout">Log out</a>
              </Button>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="destructive">Delete account</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete account?</DialogTitle>
                    <DialogDescription>
                      Your email will be deleted from the DB and all games you
                      played will appear as &apos;Deleted User&apos; and you
                      won&apos;t be able to play again with this account. Are
                      you sure?
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button variant="destructive">Delete account</Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
