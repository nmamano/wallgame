import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "@/components/theme-provider";
import { Info } from "lucide-react";
import {
  GameConfigurationPanel,
  type GameConfiguration,
} from "@/components/game-configuration-panel";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

// Settings storage keys
const STORAGE_KEYS = {
  DISPLAY_NAME: "wall-game-display-name",
  BOARD_THEME: "wall-game-board-theme",
  PAWN_COLOR: "wall-game-pawn-color",
  CAT_PAWN: "wall-game-cat-pawn",
  MOUSE_PAWN: "wall-game-mouse-pawn",
  GAME_CONFIG: "wall-game-default-config",
} as const;

// Load settings from localStorage
function loadLocalSettings() {
  if (typeof window === "undefined") return null;
  return {
    displayName: localStorage.getItem(STORAGE_KEYS.DISPLAY_NAME) || "",
    boardTheme: localStorage.getItem(STORAGE_KEYS.BOARD_THEME) || "classic",
    pawnColor: localStorage.getItem(STORAGE_KEYS.PAWN_COLOR) || "default",
    catPawn: localStorage.getItem(STORAGE_KEYS.CAT_PAWN) || "default",
    mousePawn: localStorage.getItem(STORAGE_KEYS.MOUSE_PAWN) || "default",
    gameConfig: (() => {
      const stored = localStorage.getItem(STORAGE_KEYS.GAME_CONFIG);
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch {
          return null;
        }
      }
      return null;
    })(),
  };
}

// Save settings to localStorage
function saveLocalSetting(key: string, value: string) {
  if (typeof window !== "undefined") {
    localStorage.setItem(key, value);
  }
}

function saveLocalGameConfig(config: GameConfiguration) {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEYS.GAME_CONFIG, JSON.stringify(config));
  }
}

// Validate display name
function isValidDisplayName(name: string): { valid: boolean; error?: string } {
  const lowerName = name.toLowerCase();
  if (
    lowerName.includes("guest") ||
    lowerName.includes("deleted") ||
    lowerName.includes("bot")
  ) {
    return {
      valid: false,
      error: "Names including 'guest', 'deleted', or 'bot' are not allowed.",
    };
  }
  if (name.trim().length === 0) {
    return { valid: false, error: "Display name cannot be empty." };
  }
  return { valid: true };
}

function Settings() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;

  const localSettings = loadLocalSettings();

  // User settings state
  const [displayName, setDisplayName] = useState(
    userData?.user?.given_name || userData?.user?.family_name || ""
  );
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [isChangingName, setIsChangingName] = useState(false);

  // Visual style state
  const [boardTheme, setBoardTheme] = useState(
    localSettings?.boardTheme || "classic"
  );
  const [pawnColor, setPawnColor] = useState(
    localSettings?.pawnColor || "default"
  );
  const [catPawn, setCatPawn] = useState(localSettings?.catPawn || "default");
  const [mousePawn, setMousePawn] = useState(
    localSettings?.mousePawn || "default"
  );

  // Default game parameters state
  const defaultGameConfig: GameConfiguration = {
    timeControl: "rapid",
    rated: false,
    variant: "standard",
    boardWidth: 8,
    boardHeight: 8,
  };
  const [gameConfig, setGameConfig] = useState<GameConfiguration>(
    localSettings?.gameConfig || defaultGameConfig
  );

  // Update display name when user data loads
  useEffect(() => {
    if (userData?.user && !isChangingName) {
      const name = userData.user.given_name || userData.user.family_name || "";
      setDisplayName(name);
    }
  }, [userData?.user, isChangingName]);

  // Save visual style settings to localStorage when not logged in
  useEffect(() => {
    if (!isLoggedIn) {
      saveLocalSetting(STORAGE_KEYS.BOARD_THEME, boardTheme);
      saveLocalSetting(STORAGE_KEYS.PAWN_COLOR, pawnColor);
      saveLocalSetting(STORAGE_KEYS.CAT_PAWN, catPawn);
      saveLocalSetting(STORAGE_KEYS.MOUSE_PAWN, mousePawn);
    }
    // TODO: Save to API when logged in
  }, [boardTheme, pawnColor, catPawn, mousePawn, isLoggedIn]);

  // Save game config to localStorage when not logged in
  useEffect(() => {
    if (!isLoggedIn) {
      saveLocalGameConfig(gameConfig);
    }
    // TODO: Save to API when logged in
  }, [gameConfig, isLoggedIn]);

  const handleChangeDisplayName = async () => {
    const validation = isValidDisplayName(displayName);
    if (!validation.valid) {
      setDisplayNameError(validation.error || "Invalid display name");
      return;
    }

    setDisplayNameError(null);
    setIsChangingName(true);

    // TODO: Make API call to change display name
    // For now, just save to localStorage if not logged in
    if (!isLoggedIn) {
      saveLocalSetting(STORAGE_KEYS.DISPLAY_NAME, displayName);
    } else {
      // TODO: API call to update display name
      console.log("Changing display name to:", displayName);
    }
  };

  const currentDisplayName = isLoggedIn
    ? userData?.user?.given_name || userData?.user?.family_name || ""
    : "Guest";

  const canChangeName =
    isLoggedIn &&
    displayName !== currentDisplayName &&
    displayName.trim().length > 0;

  if (userPending) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

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

          {/* 1. User Settings */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">User Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="display-name">Display Name</Label>
                <div className="flex gap-2">
                  <Input
                    id="display-name"
                    value={isLoggedIn ? displayName : "Guest"}
                    onChange={(e) => {
                      if (isLoggedIn) {
                        setDisplayName(e.target.value);
                        setDisplayNameError(null);
                      }
                    }}
                    disabled={!isLoggedIn}
                    className={`bg-background ${!isLoggedIn ? "opacity-50" : ""}`}
                    placeholder={isLoggedIn ? "Enter display name" : ""}
                  />
                  {isLoggedIn && (
                    <Button
                      onClick={handleChangeDisplayName}
                      disabled={!canChangeName}
                      variant="outline"
                    >
                      Change if available
                    </Button>
                  )}
                </div>
                {displayNameError && (
                  <p className="text-sm text-destructive">{displayNameError}</p>
                )}
                {isLoggedIn ? (
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
                      onClick={() => navigate({ to: "/profile" })}
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
              <CardTitle className="text-2xl">Visual Style</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {isLoggedIn
                    ? "These settings are saved to your account."
                    : "These settings are saved as local cookies in your web browser."}
                </AlertDescription>
              </Alert>

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="dark-theme">Dark Theme</Label>
                  <p className="text-sm text-muted-foreground">
                    Toggle dark mode on or off
                  </p>
                </div>
                <Switch
                  id="dark-theme"
                  checked={theme === "dark"}
                  onCheckedChange={(checked) =>
                    setTheme(checked ? "dark" : "light")
                  }
                />
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor="board-theme">Board Theme</Label>
                <Select value={boardTheme} onValueChange={setBoardTheme}>
                  <SelectTrigger id="board-theme" className="bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="classic">Classic</SelectItem>
                    {/* Add more board themes here */}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pawn-color">Pawn Color</Label>
                <Select value={pawnColor} onValueChange={setPawnColor}>
                  <SelectTrigger id="pawn-color" className="bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {/* Add more pawn colors here */}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cat-pawn">Cat Pawn</Label>
                <Select value={catPawn} onValueChange={setCatPawn}>
                  <SelectTrigger id="cat-pawn" className="bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {/* Add more cat pawn options here */}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="mouse-pawn">Mouse Pawn</Label>
                <Select value={mousePawn} onValueChange={setMousePawn}>
                  <SelectTrigger id="mouse-pawn" className="bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {/* Add more mouse pawn options here */}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* 3. Default Game Parameters */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">
                Default Game Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {isLoggedIn
                    ? "These settings are saved to your account."
                    : "These settings are saved as local cookies in your web browser."}
                </AlertDescription>
              </Alert>

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
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
