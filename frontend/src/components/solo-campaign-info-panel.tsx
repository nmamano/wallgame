import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AudioControls } from "@/components/audio-controls";
import { RotateCcw } from "lucide-react";
import type { SoloCampaignLevel } from "../../../shared/domain/solo-campaign-levels";

interface SoloCampaignInfoPanelProps {
  level: SoloCampaignLevel;
  turnsRemaining: number;
  onReset: () => void;
  isAiThinking: boolean;
}

/**
 * Parse level info text and render with colored text.
 * Supports {red}text{/red} and {blue}text{/blue} for colors,
 * and **text** for bold.
 */
function renderInfoText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const remaining = text;
  let key = 0;

  // Pattern to match {red}...{/red}, {blue}...{/blue}, **...**, or newlines
  const pattern =
    /(\{red\}(.*?)\{\/red\}|\{blue\}(.*?)\{\/blue\}|\*\*(.*?)\*\*|\n\n)/g;

  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(remaining)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(remaining.slice(lastIndex, match.index));
    }

    if (match[0].startsWith("{red}")) {
      // Red colored text
      const innerText = match[2];
      parts.push(
        <span key={key++} className="text-red-500 font-semibold">
          {renderInfoText(innerText)}
        </span>,
      );
    } else if (match[0].startsWith("{blue}")) {
      // Blue colored text
      const innerText = match[3];
      parts.push(
        <span key={key++} className="text-blue-500 font-semibold">
          {renderInfoText(innerText)}
        </span>,
      );
    } else if (match[0].startsWith("**")) {
      // Bold text
      const innerText = match[4];
      parts.push(
        <strong key={key++} className="font-semibold">
          {innerText}
        </strong>,
      );
    } else if (match[0] === "\n\n") {
      // Paragraph break
      parts.push(<br key={key++} />);
      parts.push(<br key={key++} />);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < remaining.length) {
    parts.push(remaining.slice(lastIndex));
  }

  return parts;
}

export function SoloCampaignInfoPanel({
  level,
  turnsRemaining,
  onReset,
  isAiThinking,
}: SoloCampaignInfoPanelProps) {
  return (
    <Card className="p-4 bg-card/80 backdrop-blur border-border/50">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          Level {level.id}: {level.name}
        </h2>
        <div className="flex items-center gap-2">
          <AudioControls />
          {/* Reset button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onReset}
            disabled={isAiThinking}
            title="Reset level"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Level description */}
      <div className="text-sm text-muted-foreground mb-3 leading-relaxed">
        {renderInfoText(level.infoText)}
      </div>

      {/* Turns remaining counter */}
      <div className="text-sm font-medium">
        Turns remaining: <span className="font-bold">{turnsRemaining}</span>
      </div>
    </Card>
  );
}
