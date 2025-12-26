import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";
import type {
  GameConfiguration,
  TimeControlPreset,
  Variant,
} from "../../../shared/domain/game-types";
import { timeControlConfigFromPreset } from "../../../shared/domain/game-utils";

const BOARD_SIZE_MIN = 4;
const BOARD_SIZE_MAX = 20;

const isBoardSizeDraft = (value: string): boolean => {
  if (!/^\d{0,2}$/.test(value)) {
    return false;
  }
  if (value === "") {
    return true;
  }
  const numeric = Number(value);
  if (numeric >= BOARD_SIZE_MIN && numeric <= BOARD_SIZE_MAX) {
    return true;
  }
  return value.length === 1 && (value === "1" || value === "2");
};

const clampBoardSize = (value: number): number =>
  Math.min(Math.max(value, BOARD_SIZE_MIN), BOARD_SIZE_MAX);

interface GameConfigurationPanelProps {
  config: GameConfiguration;
  onChange: (config: GameConfiguration) => void;
  isLoggedIn?: boolean;
  showRatedInfo?: boolean;
  ratedDisabled?: boolean; // Disable rated switch (e.g., when playing with bots)
  showRatedDisabledMessage?: boolean; // Show message explaining why rated is disabled
}

export function GameConfigurationPanel({
  config,
  onChange,
  isLoggedIn = false,
  showRatedInfo = true,
  ratedDisabled = false,
  showRatedDisabledMessage = false,
}: GameConfigurationPanelProps) {
  // Ensure rated is false when not logged in or when rated is disabled
  useEffect(() => {
    if ((!isLoggedIn || ratedDisabled) && config.rated) {
      onChange({ ...config, rated: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, ratedDisabled]);

  const [boardWidthInput, setBoardWidthInput] = useState(() =>
    String(config.boardWidth),
  );
  const [boardHeightInput, setBoardHeightInput] = useState(() =>
    String(config.boardHeight),
  );

  useEffect(() => {
    setBoardWidthInput(String(config.boardWidth));
  }, [config.boardWidth]);

  useEffect(() => {
    setBoardHeightInput(String(config.boardHeight));
  }, [config.boardHeight]);

  const updateConfig = (updates: Partial<GameConfiguration>) => {
    // Prevent setting rated to true if not logged in or if rated is disabled
    if ((!isLoggedIn || ratedDisabled) && updates.rated === true) {
      return;
    }
    onChange({ ...config, ...updates });
  };

  const handleBoardWidthChange = (nextValue: string) => {
    if (!isBoardSizeDraft(nextValue)) {
      return;
    }

    if (nextValue === "") {
      setBoardWidthInput(nextValue);
      return;
    }

    const numeric = Number(nextValue);
    if (numeric >= BOARD_SIZE_MIN && numeric <= BOARD_SIZE_MAX) {
      setBoardWidthInput(String(numeric));
      if (numeric !== config.boardWidth) {
        updateConfig({ boardWidth: numeric });
      }
      return;
    }

    setBoardWidthInput(nextValue);
  };

  const handleBoardHeightChange = (nextValue: string) => {
    if (!isBoardSizeDraft(nextValue)) {
      return;
    }

    if (nextValue === "") {
      setBoardHeightInput(nextValue);
      return;
    }

    const numeric = Number(nextValue);
    if (numeric >= BOARD_SIZE_MIN && numeric <= BOARD_SIZE_MAX) {
      setBoardHeightInput(String(numeric));
      if (numeric !== config.boardHeight) {
        updateConfig({ boardHeight: numeric });
      }
      return;
    }

    setBoardHeightInput(nextValue);
  };

  const commitBoardWidth = () => {
    if (boardWidthInput === "") {
      setBoardWidthInput(String(config.boardWidth));
      return;
    }

    const numeric = Number(boardWidthInput);
    if (!Number.isFinite(numeric)) {
      setBoardWidthInput(String(config.boardWidth));
      return;
    }

    const clamped = clampBoardSize(numeric);
    setBoardWidthInput(String(clamped));
    if (clamped !== config.boardWidth) {
      updateConfig({ boardWidth: clamped });
    }
  };

  const commitBoardHeight = () => {
    if (boardHeightInput === "") {
      setBoardHeightInput(String(config.boardHeight));
      return;
    }

    const numeric = Number(boardHeightInput);
    if (!Number.isFinite(numeric)) {
      setBoardHeightInput(String(config.boardHeight));
      return;
    }

    const clamped = clampBoardSize(numeric);
    setBoardHeightInput(String(clamped));
    if (clamped !== config.boardHeight) {
      updateConfig({ boardHeight: clamped });
    }
  };

  const renderVariantParameters = () => {
    if (config.variant === "standard" || config.variant === "classic") {
      return (
        <div className="space-y-3 p-3 border rounded-md bg-muted/30">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center gap-3">
              <Label htmlFor="board-width" className="min-w-[100px]">
                Board Width
              </Label>
              <Input
                id="board-width"
                type="number"
                min="4"
                max="20"
                value={boardWidthInput}
                onChange={(e) => handleBoardWidthChange(e.target.value)}
                onBlur={commitBoardWidth}
                className="bg-background max-w-[100px]"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="board-height" className="min-w-[100px]">
                Board Height
              </Label>
              <Input
                id="board-height"
                type="number"
                min="4"
                max="20"
                value={boardHeightInput}
                onChange={(e) => handleBoardHeightChange(e.target.value)}
                onBlur={commitBoardHeight}
                className="bg-background max-w-[100px]"
              />
            </div>
          </div>
        </div>
      );
    }
    // Add more variant-specific parameter rendering here
    return null;
  };

  return (
    <div className="space-y-4">
      {/* Time Control and Variant side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-center gap-3">
          <Label htmlFor="time-control" className="min-w-[120px]">
            Time Control
          </Label>
          <Select
            value={config.timeControl.preset ?? "blitz"}
            onValueChange={(value: TimeControlPreset) =>
              updateConfig({ timeControl: timeControlConfigFromPreset(value) })
            }
          >
            <SelectTrigger
              id="time-control"
              className="bg-background w-[200px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bullet">Bullet (1+0)</SelectItem>
              <SelectItem value="blitz">Blitz (3+2)</SelectItem>
              <SelectItem value="rapid">Rapid (10+2)</SelectItem>
              <SelectItem value="classical">Classical (30+0)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <Label htmlFor="variant" className="min-w-[120px]">
            Variant
          </Label>
          <Select
            value={config.variant}
            onValueChange={(value: Variant) => {
              // Don't reset parameters here - let the parent component handle loading saved parameters
              onChange({
                ...config,
                variant: value,
              });
            }}
          >
            <SelectTrigger id="variant" className="bg-background w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">Standard</SelectItem>
              <SelectItem value="classic">Classic</SelectItem>
              <SelectItem value="freestyle">Freestyle</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="rated">Rated Status</Label>
            <p className="text-sm text-muted-foreground">
              Rated games affect your rating
            </p>
          </div>
          <Switch
            id="rated"
            checked={config.rated}
            onCheckedChange={(checked) => updateConfig({ rated: checked })}
            disabled={!isLoggedIn || ratedDisabled}
          />
        </div>
        {/* Always render message container to prevent layout shift */}
        {/* min-h accommodates up to 2 lines of text-sm */}
        <div className="min-h-[2.5rem]">
          {showRatedInfo && !isLoggedIn && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                You need to be logged in to play rated games.
              </AlertDescription>
            </Alert>
          )}
          {showRatedDisabledMessage && ratedDisabled && (
            <p className="text-sm text-muted-foreground">
              Rated games are only available when playing against a friend or
              matched player. Games with bots are always unrated.
            </p>
          )}
        </div>
      </div>

      {renderVariantParameters()}
    </div>
  );
}
