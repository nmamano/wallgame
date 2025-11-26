import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
  channel: "game" | "team" | "audience";
  isSystem?: boolean;
}

interface GameChatPanelProps {
  chatChannel: "game" | "team" | "audience";
  messages: ChatMessage[];
  chatInput: string;
  onChannelChange: (channel: "game" | "team" | "audience") => void;
  onInputChange: (value: string) => void;
  onSendMessage: (e: React.FormEvent) => void;
}

export function GameChatPanel({
  chatChannel,
  messages,
  chatInput,
  onChannelChange,
  onInputChange,
  onSendMessage,
}: GameChatPanelProps) {
  return (
    <>
      <div className="flex p-2 gap-1 bg-muted/30 flex-shrink-0">
        {(["game", "team", "audience"] as const).map((channel) => (
          <button
            key={channel}
            onClick={() => onChannelChange(channel)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              chatChannel === channel
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted text-muted-foreground"
            }`}
          >
            {channel.charAt(0).toUpperCase() + channel.slice(1)}
          </button>
        ))}
      </div>
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-3">
          {messages
            .filter(
              (message) => message.channel === chatChannel || message.isSystem,
            )
            .map((message) => (
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
                    message.isSystem
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
      </ScrollArea>
      <form
        onSubmit={onSendMessage}
        className="p-3 border-t bg-background/50 flex-shrink-0"
      >
        <Input
          value={chatInput}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder={`Message ${chatChannel}...`}
          className="bg-background"
        />
      </form>
    </>
  );
}
