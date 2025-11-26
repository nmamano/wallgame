import { Card } from "@/components/ui/card";
import { History, MessageSquare } from "lucide-react";
import { MoveListPanel } from "@/components/move-list-panel";
import { GameChatPanel } from "@/components/game-chat-panel";

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
  channel: "game" | "team" | "audience";
  isSystem?: boolean;
}

interface MoveListAndChatPanelProps {
  adjustedChatCardHeight: number;
  activeTab: "chat" | "history";
  onTabChange: (tab: "chat" | "history") => void;
  formattedHistory: {
    num: number;
    white?: string;
    black?: string;
  }[];
  chatChannel: "game" | "team" | "audience";
  messages: ChatMessage[];
  chatInput: string;
  onChannelChange: (channel: "game" | "team" | "audience") => void;
  onInputChange: (value: string) => void;
  onSendMessage: (e: React.FormEvent) => void;
}

export function MoveListAndChatPanel({
  adjustedChatCardHeight,
  activeTab,
  onTabChange,
  formattedHistory,
  chatChannel,
  messages,
  chatInput,
  onChannelChange,
  onInputChange,
  onSendMessage,
}: MoveListAndChatPanelProps) {
  return (
    <Card
      className="flex flex-col overflow-hidden bg-card/50 backdrop-blur"
      style={{
        height: `${adjustedChatCardHeight}rem`,
        minHeight: `${adjustedChatCardHeight}rem`,
      }}
    >
      <div className="flex border-b flex-shrink-0">
        <button
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === "history"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onTabChange("history")}
        >
          <div className="flex items-center justify-center gap-2">
            <History className="w-4 h-4" />
            Moves
          </div>
        </button>
        <button
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === "chat"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onTabChange("chat")}
        >
          <div className="flex items-center justify-center gap-2">
            <MessageSquare className="w-4 h-4" />
            Chat
          </div>
        </button>
      </div>

      <div className="flex-1 overflow-hidden relative flex flex-col">
        {activeTab === "chat" ? (
          <GameChatPanel
            chatChannel={chatChannel}
            messages={messages}
            chatInput={chatInput}
            onChannelChange={onChannelChange}
            onInputChange={onInputChange}
            onSendMessage={onSendMessage}
          />
        ) : (
          <MoveListPanel formattedHistory={formattedHistory} />
        )}
      </div>
    </Card>
  );
}
