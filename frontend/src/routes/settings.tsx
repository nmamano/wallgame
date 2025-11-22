import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info, Loader2 } from "lucide-react";
import { GameConfigurationPanel } from "@/components/game-configuration-panel";
import { PawnSelector } from "@/components/pawn-selector";
import { CAT_PAWNS } from "@/lib/cat-pawns";
import { MOUSE_PAWNS } from "@/lib/mouse-pawns";
import { PLAYER_COLORS, colorDisplayNames, colorHexMap } from "@/lib/player-colors";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  const navigate = useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;

  // Use settings hook - abstracts logged-in vs logged-out implementation
  // The hook owns all settings data fetching, including display name
  const {
    boardTheme,
    setBoardTheme,
    pawnColor,
    setPawnColor,
    catPawn,
    setCatPawn,
    mousePawn,
    setMousePawn,
    gameConfig,
    setGameConfig,
    displayName,
    setDisplayName,
    displayNameError,
    displayNameValidationError,
    handleChangeDisplayName,
    canChangeName,
    isLoadingSettings,
    isSavingName,
    isSavingVisualStyle,
    isSavingGameParameters,
    loadError,
    saveError,
  } = useSettings(isLoggedIn, userPending);

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Header */}
          <div className="space-y-2">
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground">
              Settings
            </h1>
            <p className="text-lg text-muted-foreground">
              Customize your Wall Game experience
            </p>
          </div>

          {/* Load Error Alert */}
          {loadError && isLoggedIn && (
            <Alert variant="destructive">
              <Info className="h-4 w-4" />
              <AlertDescription>
                Failed to load your settings; using defaults.{" "}
                {loadError instanceof Error
                  ? loadError.message
                  : String(loadError)}
              </AlertDescription>
            </Alert>
          )}

          {/* Global Save Error Alert */}
          {saveError && isLoggedIn && (
            <Alert variant="destructive">
              <Info className="h-4 w-4" />
              <AlertDescription>
                Failed to save settings:{" "}
                {saveError instanceof Error
                  ? saveError.message
                  : String(saveError)}
              </AlertDescription>
            </Alert>
          )}

          {/* 1. User Settings */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl flex items-center gap-2">
                User Settings
                {isSavingName && isLoggedIn && (
                  <span className="text-sm font-normal text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="display-name">Display Name</Label>
                <div className="flex gap-2">
                  {userPending || (isLoggedIn && isLoadingSettings) ? (
                    <Input
                      id="display-name"
                      value=""
                      disabled
                      className="bg-background opacity-50"
                      placeholder="Loading..."
                    />
                  ) : (
                    <Input
                      id="display-name"
                      value={isLoggedIn ? displayName : "Guest"}
                      onChange={(e) => {
                        if (isLoggedIn) {
                          setDisplayName(e.target.value);
                        }
                      }}
                      disabled={!isLoggedIn}
                      className={`bg-background ${!isLoggedIn ? "opacity-50 cursor-not-allowed" : ""}`}
                      placeholder={isLoggedIn ? "Enter display name" : ""}
                    />
                  )}
                  {isLoggedIn && !userPending && !isLoadingSettings && (
                    <Button
                      onClick={handleChangeDisplayName}
                      disabled={!canChangeName || isSavingName}
                      variant="outline"
                    >
                      {isSavingName ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Change if available"
                      )}
                    </Button>
                  )}
                </div>
                {(displayNameValidationError ?? displayNameError) && (
                  <p className="text-sm text-destructive">
                    {displayNameValidationError ?? displayNameError}
                  </p>
                )}
                {userPending ? (
                  <p className="text-sm text-muted-foreground">
                    Checking authentication status...
                  </p>
                ) : isLoggedIn ? (
                  <p className="text-sm text-muted-foreground">
                    Names must be unique across the site (case insensitive). You
                    can only switch to another name not already in use.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      You need to be logged in to change your display name.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        void navigate({ to: "/profile" });
                      }}
                    >
                      Go to Profile
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 2. Visual Style */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl flex items-center gap-2">
                Visual Style
                {isSavingVisualStyle && isLoggedIn && (
                  <span className="text-sm font-normal text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {isLoggedIn
                    ? "These settings are saved to your account."
                    : "These settings are saved locally in your web browser."}
                </AlertDescription>
              </Alert>

              {isLoadingSettings && isLoggedIn && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading your settings...</span>
                </div>
              )}

              <div
                className={`space-y-6 ${isLoadingSettings && isLoggedIn ? "opacity-50 pointer-events-none" : ""}`}
              >
                <div className="space-y-2">
                  <Label htmlFor="board-theme">Board Theme</Label>
                  <Select
                    value={boardTheme}
                    onValueChange={setBoardTheme}
                    disabled={isLoadingSettings && isLoggedIn}
                  >
                    <SelectTrigger id="board-theme" className="bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {/* Add more board themes here */}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pawn-color">Player Color</Label>
                  <Select
                    value={pawnColor}
                    onValueChange={setPawnColor}
                    disabled={isLoadingSettings && isLoggedIn}
                  >
                    <SelectTrigger id="pawn-color" className="bg-background">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLAYER_COLORS.map((color) => (
                        <SelectItem key={color} value={color}>
                          <div className="flex items-center gap-2">
                            <div
                              className="w-4 h-4 rounded-full border border-gray-300"
                              style={{ backgroundColor: colorHexMap[color] }}
                            />
                            <span>{colorDisplayNames[color]}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="cat-pawn">Cat Pawn</Label>
                  <PawnSelector
                    value={catPawn}
                    onChange={setCatPawn}
                    pawns={CAT_PAWNS}
                    basePath="/pawns/cat/"
                    label="Cat Pawn"
                    defaultLabel="Default Cat"
                    color={pawnColor}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mouse-pawn">Mouse Pawn</Label>
                  <PawnSelector
                    value={mousePawn}
                    onChange={setMousePawn}
                    pawns={MOUSE_PAWNS}
                    basePath="/pawns/mouse/"
                    label="Mouse Pawn"
                    defaultLabel="Default Mouse"
                    color={pawnColor}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 3. Default Game Parameters */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl flex items-center gap-2">
                Default Game Parameters
                {isSavingGameParameters && isLoggedIn && (
                  <span className="text-sm font-normal text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {isLoggedIn
                    ? "These settings are saved to your account."
                    : "These settings are saved locally in your web browser."}
                </AlertDescription>
              </Alert>

              {isLoadingSettings && isLoggedIn && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading your settings...</span>
                </div>
              )}

              <div
                className={`space-y-6 ${isLoadingSettings && isLoggedIn ? "opacity-50 pointer-events-none" : ""}`}
              >
                <p className="text-sm text-muted-foreground">
                  When setting up a game, these parameters will be used as
                  default.
                </p>

                <GameConfigurationPanel
                  config={gameConfig}
                  onChange={setGameConfig}
                  isLoggedIn={isLoggedIn}
                  showRatedInfo={true}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
