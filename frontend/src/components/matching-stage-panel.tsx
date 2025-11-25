import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Check, Copy, Loader2, User, Bot, Users } from "lucide-react";
import { PlayerType } from "./player-configuration";

export interface MatchingPlayer {
  id: string;
  type: PlayerType;
  name: string;
  isReady: boolean;
  isYou: boolean;
  isConnected?: boolean;
}

interface MatchingStagePanelProps {
  isOpen: boolean;
  players: MatchingPlayer[];
  shareUrl?: string;
  inviteCode?: string;
  statusMessage?: string;
  canAbort?: boolean;
  onAbort: () => void;
}

export function MatchingStagePanel({
  isOpen,
  players,
  shareUrl,
  inviteCode,
  statusMessage,
  canAbort = true,
  onAbort,
}: MatchingStagePanelProps) {
  const [copied, setCopied] = useState(false);
  const resolvedShareUrl =
    shareUrl ??
    (typeof window !== "undefined" ? window.location.href : undefined);

  const handleCopyLink = () => {
    if (!resolvedShareUrl || typeof navigator === "undefined") return;
    void navigator.clipboard.writeText(resolvedShareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getPlayerIcon = (type: PlayerType) => {
    if (type === "you" || type === "friend" || type === "matched-user") {
      return <User className="h-5 w-5" />;
    }
    return <Bot className="h-5 w-5" />;
  };

  const getPlayerLabel = (player: MatchingPlayer) => {
    switch (player.type) {
      case "you":
        return "You";
      case "friend":
        return "Friend";
      case "matched-user":
        return "Matched Player";
      case "easy-bot":
        return "Easy Bot";
      case "medium-bot":
        return "Medium Bot";
      case "hard-bot":
        return "Hard Bot";
      case "custom-bot":
        return "Custom Bot";
      default:
        return player.name;
    }
  };

  const renderInstructions = (player: MatchingPlayer) => {
    if (player.isReady) return null;

    if (player.type === "friend") {
      return (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-muted-foreground">
            Share this link with your friend:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted p-2 rounded text-xs truncate">
              {resolvedShareUrl ?? "Share link unavailable"}
            </code>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              onClick={handleCopyLink}
              disabled={!resolvedShareUrl}
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      );
    }

    if (player.type === "custom-bot") {
      return (
        <div className="mt-2">
          <p className="text-sm text-muted-foreground">
            Access token:{" "}
            <code className="bg-muted px-1 rounded">bot_token_123</code>
          </p>
        </div>
      );
    }

    if (player.type === "matched-user") {
      return (
        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting for someone to join...
        </div>
      );
    }

    return null;
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={() => {
        // Dialog should not be closable during matching stage
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Waiting for players
          </DialogTitle>
          {statusMessage && (
            <p className="text-sm text-muted-foreground">{statusMessage}</p>
          )}
          {inviteCode && (
            <p className="text-xs text-muted-foreground font-mono">
              Invite code: {inviteCode}
            </p>
          )}
        </DialogHeader>

        <div className="space-y-4 py-4">
          {players.map((player) => (
            <Card key={player.id} className="p-4 border-border/50">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 font-medium">
                  {getPlayerIcon(player.type)}
                  <span>{getPlayerLabel(player)}</span>
                  {player.isYou && (
                    <span className="text-xs text-muted-foreground">(You)</span>
                  )}
                  {typeof player.isConnected === "boolean" && (
                    <span
                      className={`flex items-center gap-1 text-xs ${
                        player.isConnected ? "text-green-600" : "text-muted-foreground"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          player.isConnected ? "bg-green-500" : "bg-gray-400"
                        }`}
                      />
                      {player.isConnected ? "Connected" : "Waiting"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {player.isReady ? (
                    <span className="flex items-center gap-1 text-sm text-green-600 font-medium">
                      <Check className="h-4 w-4" />
                      Ready
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-sm text-amber-600 font-medium">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Waiting
                    </span>
                  )}
                </div>
              </div>
              {renderInstructions(player)}
            </Card>
          ))}
        </div>

        <div className="flex justify-center">
          <Button variant="destructive" onClick={onAbort} disabled={!canAbort}>
            Abort Game
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
