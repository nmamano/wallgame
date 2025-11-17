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
}: PlayerConfigurationProps) {
  const selectedInfo = value ? PLAYER_TYPE_INFO[value] : null;
  const id = `player-type-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="bg-background w-full">
          <SelectValue placeholder="Select player type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="you">You</SelectItem>
          <SelectItem value="friend">Friend</SelectItem>
          <SelectItem value="matched-user">Matched user</SelectItem>
          <SelectItem value="easy-bot">Easy Bot</SelectItem>
          <SelectItem value="medium-bot">Medium Bot</SelectItem>
          <SelectItem value="hard-bot">Hard Bot</SelectItem>
          <SelectItem value="custom-bot">Custom bot</SelectItem>
        </SelectContent>
      </Select>
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
