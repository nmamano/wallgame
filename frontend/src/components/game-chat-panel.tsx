import { useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
  channel: "game" | "team" | "audience";
  isSystem?: boolean;
  isError?: boolean;
}

interface GameChatPanelProps {
  chatChannel: "game" | "team" | "audience";
  messages: ChatMessage[];
  chatInput: string;
  onChannelChange: (channel: "game" | "team" | "audience") => void;
  onInputChange: (value: string) => void;
  onSendMessage: (e: React.FormEvent) => void;
  isSpectator: boolean;
  isReplay: boolean;
  isTeamVariant: boolean;
  isSending: boolean;
  isOnlineGame: boolean;
}

export function GameChatPanel({
  chatChannel,
  messages,
  chatInput,
  onChannelChange,
  onInputChange,
  onSendMessage,
  isSpectator,
  isReplay,
  isTeamVariant,
  isSending,
  isOnlineGame,
}: GameChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Track scroll position during user scrolling
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 10;
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  // Auto-scroll to bottom when new messages come in (only if was at bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const isChannelDisabled = (
    channel: "game" | "team" | "audience",
  ): boolean => {
    if (!isOnlineGame) return true;
    if (isReplay) return true;
    if (channel === "game" && isSpectator) return true;
    if (channel === "team" && (isSpectator || !isTeamVariant)) return true;
    if (channel === "audience" && !isSpectator) return true;
    return false;
  };

  const getDisabledMessage = (): string | null => {
    if (!isOnlineGame) return "Chat is only for online games.";
    if (isReplay) return "Chat is not preserved.";
    if (chatChannel === "game" && isSpectator)
      return "Game chat is for players only.";
    if (chatChannel === "team" && isSpectator)
      return "Team chat is for players only.";
    if (chatChannel === "team" && !isTeamVariant)
      return "Team chat is disabled in 1v1 games.";
    if (chatChannel === "audience" && !isSpectator)
      return "Audience chat is for spectators only.";
    return null;
  };

  const disabledMessage = getDisabledMessage();
  const currentChannelDisabled = isChannelDisabled(chatChannel);

  // Only show actual chat messages (non-system) and chat-specific error messages.
  // System messages for draws, takebacks, etc. have their own notification area.
  const filteredMessages = messages.filter(
    (message) =>
      message.channel === chatChannel && (!message.isSystem || message.isError),
  );

  return (
    <>
      <div className="flex p-2 gap-1 bg-muted/30 flex-shrink-0">
        {(["game", "team", "audience"] as const).map((channel) => {
          const disabled = isChannelDisabled(channel);
          return (
            <button
              key={channel}
              onClick={() => onChannelChange(channel)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                chatChannel === channel
                  ? "bg-primary text-primary-foreground"
                  : disabled
                    ? "text-muted-foreground/50 hover:bg-muted cursor-pointer"
                    : "hover:bg-muted text-muted-foreground cursor-pointer"
              }`}
            >
              {channel.charAt(0).toUpperCase() + channel.slice(1)}
            </button>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-none p-4"
      >
        {currentChannelDisabled && disabledMessage ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground text-sm italic text-center">
              {disabledMessage}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredMessages.map((message) => (
              <div
                key={message.id}
                className={`flex flex-col ${
                  message.sender === "You" ? "items-end" : "items-start"
                }`}
              >
                {!message.isSystem && (
                  <span className="text-[10px] text-muted-foreground mb-1">
                    {message.sender}
                  </span>
                )}
                <div
                  className={`px-3 py-2 rounded-lg text-sm max-w-[85%] ${
                    message.isError
                      ? "bg-destructive/10 text-destructive text-center w-full"
                      : message.isSystem
                        ? "bg-muted text-muted-foreground text-center w-full italic"
                        : message.sender === "You"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                  }`}
                >
                  {message.text}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={onSendMessage}
        className="p-3 border-t bg-background/50 flex-shrink-0 flex gap-2"
      >
        <Input
          value={chatInput}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder={
            currentChannelDisabled ? "" : `Message ${chatChannel}...`
          }
          className={`bg-background flex-1 ${isSending ? "opacity-50" : ""}`}
          maxLength={280}
          disabled={currentChannelDisabled || isSending}
          readOnly={isSending}
        />
        <Button
          type="submit"
          size="sm"
          disabled={currentChannelDisabled || !chatInput.trim() || isSending}
          className={isSending ? "opacity-50" : ""}
        >
          <Send className="w-4 h-4" />
        </Button>
      </form>
    </>
  );
}
