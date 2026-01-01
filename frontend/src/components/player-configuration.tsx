import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PlayerType } from "@/lib/gameViewModel";

interface PlayerConfigurationProps {
  value?: PlayerType;
  onChange: (value: PlayerType) => void;
  label?: string;
  allowedOptions?: PlayerType[];
  optionLabelOverrides?: Partial<Record<PlayerType, string>>;
}

const PLAYER_TYPE_INFO: Record<PlayerType, { text: string }> = {
  you: { text: "You'll make the moves." },
  friend: {
    text: "You'll get a link to share with a friend to join the game.",
  },
  "matched-user": {
    text: "You'll be paired with a random player with compatible settings and similar rating.",
  },
};

export function PlayerConfiguration({
  value,
  onChange,
  label = "Player Configuration",
  allowedOptions,
  optionLabelOverrides,
}: PlayerConfigurationProps) {
  const selectedInfo = value ? PLAYER_TYPE_INFO[value] : null;
  const id = `player-type-${label.toLowerCase().replace(/\s+/g, "-")}`;

  const allOptions: { value: PlayerType; label: string }[] = [
    { value: "you", label: "You" },
    { value: "friend", label: "Friend" },
    { value: "matched-user", label: "Matched user" },
  ];

  const resolvedOptions =
    allowedOptions && allowedOptions.length > 0
      ? allowedOptions
          .map((allowed) =>
            allOptions.find((option) => option.value === allowed),
          )
          .filter((option): option is { value: PlayerType; label: string } =>
            Boolean(option),
          )
      : allOptions;

  const availableOptions = resolvedOptions.map((option) => ({
    value: option.value,
    label: optionLabelOverrides?.[option.value] ?? option.label,
  }));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Label htmlFor={id} className="min-w-[100px]">
          {label}
        </Label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} className="bg-background w-[200px]">
            <SelectValue placeholder="Select player type" />
          </SelectTrigger>
          <SelectContent>
            {availableOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* Always render text container to prevent layout shift */}
      {/* min-h accommodates up to 2 lines of text-sm (text-sm line-height ~1.5, so 2 lines ≈ 3rem) */}
      <div className="min-h-[3rem]">
        {selectedInfo && (
          <p className="text-sm text-muted-foreground">{selectedInfo.text}</p>
        )}
      </div>
    </div>
  );
}
