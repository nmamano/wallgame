import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PlayerType =
  | "you"
  | "friend"
  | "matched-user"
  | "easy-bot"
  | "medium-bot"
  | "hard-bot"
  | "custom-bot";

interface PlayerConfigurationProps {
  value?: PlayerType;
  onChange: (value: PlayerType) => void;
  customBotBlogUrl?: string;
  label?: string;
  excludeOptions?: PlayerType[]; // Options to exclude from the dropdown
  allowedOptions?: PlayerType[];
  optionLabelOverrides?: Partial<Record<PlayerType, string>>;
}

const PLAYER_TYPE_INFO: Record<
  PlayerType,
  { text: string; hasLink?: boolean }
> = {
  you: { text: "You'll make the moves." },
  friend: {
    text: "You'll get a link to share with a friend to join the game.",
  },
  "matched-user": {
    text: "You'll be paired with a random player with compatible settings and similar rating.",
  },
  "easy-bot": { text: "You'll play against an easy AI bot." },
  "medium-bot": { text: "You'll play against a medium AI bot." },
  "hard-bot": { text: "You'll play against a hard AI bot." },
  "custom-bot": {
    text: "You'll get an access token so that you can connect your own bot.",
    hasLink: true,
  },
};

export function PlayerConfiguration({
  value,
  onChange,
  customBotBlogUrl = "#",
  label = "Player Configuration",
  excludeOptions = [],
  allowedOptions,
  optionLabelOverrides,
}: PlayerConfigurationProps) {
  const selectedInfo = value ? PLAYER_TYPE_INFO[value] : null;
  const id = `player-type-${label.toLowerCase().replace(/\s+/g, "-")}`;

  const allOptions: { value: PlayerType; label: string }[] = [
    { value: "you", label: "You" },
    { value: "friend", label: "Friend" },
    { value: "matched-user", label: "Matched user" },
    { value: "easy-bot", label: "Easy Bot" },
    { value: "medium-bot", label: "Medium Bot" },
    { value: "hard-bot", label: "Hard Bot" },
    { value: "custom-bot", label: "Custom bot" },
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

  const availableOptions = resolvedOptions
    .filter((option) => !excludeOptions.includes(option.value))
    .map((option) => ({
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
          <p className="text-sm text-muted-foreground">
            {selectedInfo.text}
            {selectedInfo.hasLink && (
              <>
                {" "}
                <a
                  href={customBotBlogUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline hover:text-primary/80"
                >
                  See here
                </a>
                {" for more information."}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
