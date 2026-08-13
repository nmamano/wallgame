import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { PawnSelector } from "@/components/pawn-selector";
import {
  CAT_PAWNS,
  DOG_PAWNS,
  ELEPHANT_PAWNS,
  HOME_PAWNS,
  MOUSE_PAWNS,
} from "@/lib/pawns";
import { dogPawnDisplayLabel } from "@/lib/pawn-labels";
import {
  SELECTABLE_PLAYER_COLORS,
  colorDisplayNames,
  colorHexMap,
} from "@/lib/player-colors";
import { BOARD_THEMES, BOARD_THEME_LABELS } from "@/lib/board-themes";
import { assetUrl } from "@/lib/asset-url";

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
    dogPawn,
    setDogPawn,
    catPawn,
    setCatPawn,
    mousePawn,
    setMousePawn,
    elephantPawn,
    setElephantPawn,
    homePawn,
    setHomePawn,
    displayName,
    setDisplayName,
    displayNameError,
    displayNameValidationError,
    handleChangeDisplayName,
    canChangeName,
    isLoadingSettings,
    isSavingName,
    isSavingVisualStyle,
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

          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardContent className="pt-0">
              {/* Saving/Loading indicator - fixed-height slot to avoid layout shift */}
              <div className="h-6 mb-2 flex items-center">
                {(isSavingName || isSavingVisualStyle || isLoadingSettings) &&
                  isLoggedIn && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>
                        {isLoadingSettings
                          ? "Loading your settings..."
                          : "Saving..."}
                      </span>
                    </div>
                  )}
              </div>

              <div
                className={`space-y-6 ${isLoadingSettings && isLoggedIn ? "opacity-50 pointer-events-none" : ""}`}
              >
                {/* Display Name */}
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
                      Names must be unique across the site (case insensitive).
                      You can only switch to another name not already in use.
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

                {/* Board Theme */}
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
                      {BOARD_THEMES.map((theme) => (
                        <SelectItem key={theme} value={theme}>
                          {BOARD_THEME_LABELS[theme]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Player Color */}
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
                      {SELECTABLE_PLAYER_COLORS.map((color) => (
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

                {/* Dog Pawn */}
                <div className="space-y-2">
                  <Label htmlFor="dog-pawn">Dog Pawn</Label>
                  <PawnSelector
                    value={dogPawn}
                    onChange={setDogPawn}
                    pawns={DOG_PAWNS}
                    basePath={assetUrl("/pawns/dog/")}
                    label="Dog Pawn"
                    defaultLabel="Current temporary default"
                    displayLabel={dogPawnDisplayLabel}
                    color={pawnColor}
                  />
                </div>

                {/* Cat Pawn */}
                <div className="space-y-2">
                  <Label htmlFor="cat-pawn">Cat Pawn</Label>
                  <PawnSelector
                    value={catPawn}
                    onChange={setCatPawn}
                    pawns={CAT_PAWNS}
                    basePath={assetUrl("/pawns/cat/")}
                    label="Cat Pawn"
                    defaultLabel="Default Cat"
                    color={pawnColor}
                  />
                </div>

                {/* Mouse Pawn */}
                <div className="space-y-2">
                  <Label htmlFor="mouse-pawn">Mouse Pawn</Label>
                  <PawnSelector
                    value={mousePawn}
                    onChange={setMousePawn}
                    pawns={MOUSE_PAWNS}
                    basePath={assetUrl("/pawns/mouse/")}
                    label="Mouse Pawn"
                    defaultLabel="Default Mouse"
                    color={pawnColor}
                  />
                </div>

                {/* Elephant Pawn */}
                <div className="space-y-2">
                  <Label htmlFor="elephant-pawn">Elephant Pawn</Label>
                  <PawnSelector
                    value={elephantPawn}
                    onChange={setElephantPawn}
                    pawns={ELEPHANT_PAWNS}
                    basePath={assetUrl("/pawns/elephant/")}
                    label="Elephant Pawn"
                    defaultLabel="Current temporary default"
                    color={pawnColor}
                  />
                </div>

                {/* Home Pawn */}
                <div className="space-y-2">
                  <Label htmlFor="home-pawn">Home Pawn</Label>
                  <PawnSelector
                    value={homePawn}
                    onChange={setHomePawn}
                    pawns={HOME_PAWNS}
                    basePath={assetUrl("/pawns/home/")}
                    label="Home Pawn"
                    defaultLabel="Default Home"
                    color={pawnColor}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <p className="text-sm text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              For guests, settings are saved locally in your web browser. If you
              log in, settings are saved to your account.
            </span>
          </p>
        </div>
      </main>
    </div>
  );
}
