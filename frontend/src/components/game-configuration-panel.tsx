import { useEffect } from "react";
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

export type TimeControl = "bullet" | "blitz" | "rapid" | "classical";
export type Variant = "standard" | "classic";

export interface GameConfiguration {
  timeControl: TimeControl;
  rated: boolean;
  variant: Variant;
  boardWidth?: number;
  boardHeight?: number;
  // Add more variant-specific parameters here as needed
}

interface GameConfigurationPanelProps {
  config: GameConfiguration;
  onChange: (config: GameConfiguration) => void;
  isLoggedIn?: boolean;
  showRatedInfo?: boolean;
}

export function GameConfigurationPanel({
  config,
  onChange,
  isLoggedIn = false,
  showRatedInfo = true,
}: GameConfigurationPanelProps) {
  // Ensure rated is false when not logged in
  useEffect(() => {
    if (!isLoggedIn && config.rated) {
      onChange({ ...config, rated: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  const updateConfig = (updates: Partial<GameConfiguration>) => {
    // Prevent setting rated to true if not logged in
    if (!isLoggedIn && updates.rated === true) {
      return;
    }
    onChange({ ...config, ...updates });
  };

  const renderVariantParameters = () => {
    if (config.variant === "standard" || config.variant === "classic") {
      return (
        <div className="space-y-4 p-4 border rounded-md bg-muted/30">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="board-width">Board Width</Label>
              <Input
                id="board-width"
                type="number"
                min="4"
                max="20"
                value={config.boardWidth ?? 8}
                onChange={(e) =>
                  updateConfig({ boardWidth: parseInt(e.target.value) || 8 })
                }
                className="bg-background"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="board-height">Board Height</Label>
              <Input
                id="board-height"
                type="number"
                min="4"
                max="20"
                value={config.boardHeight ?? 8}
                onChange={(e) =>
                  updateConfig({ boardHeight: parseInt(e.target.value) || 8 })
                }
                className="bg-background"
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
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="time-control">Time Control</Label>
        <Select
          value={config.timeControl}
          onValueChange={(value: TimeControl) =>
            updateConfig({ timeControl: value })
          }
        >
          <SelectTrigger id="time-control" className="bg-background">
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

      <div className="space-y-4">
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
            disabled={!isLoggedIn}
          />
        </div>
        {showRatedInfo && !isLoggedIn && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              You need to be logged in to play rated games.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="variant">Variant</Label>
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
          <SelectTrigger id="variant" className="bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">Standard</SelectItem>
            <SelectItem value="classic">Classic</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {renderVariantParameters()}
    </div>
  );
}
