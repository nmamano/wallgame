import { Card } from "@/components/ui/card";
import { History, MessageSquare } from "lucide-react";
import { MoveListPanel } from "@/components/move-list-panel";
import { GameChatPanel } from "@/components/game-chat-panel";
import type { MoveHistoryRow } from "@/components/move-list-panel";
import type { HistoryNav } from "@/types/history";

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
  formattedHistory: MoveHistoryRow[];
  historyNav: HistoryNav;
  hasNewMovesWhileRewound: boolean;
  historyTabHighlighted: boolean;
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
  historyNav,
  hasNewMovesWhileRewound,
  historyTabHighlighted,
  chatChannel,
  messages,
  chatInput,
  onChannelChange,
  onInputChange,
  onSendMessage,
}: MoveListAndChatPanelProps) {
  const historyTabClasses =
    activeTab === "history"
      ? "border-b-2 border-primary text-primary"
      : historyTabHighlighted
        ? "border-b-2 border-primary text-primary animate-pulse"
        : "text-muted-foreground hover:text-foreground";
  const chatTabClasses =
    activeTab === "chat"
      ? "border-b-2 border-primary text-primary"
      : "text-muted-foreground hover:text-foreground";

  return (
    <Card
      className="flex flex-col overflow-hidden bg-card/50 backdrop-blur py-0 gap-0"
      style={{
        height: `${adjustedChatCardHeight}rem`,
        minHeight: `${adjustedChatCardHeight}rem`,
      }}
    >
      <div className="flex border-b flex-shrink-0">
        <button
          className={`flex-1 py-2 lg:py-3 text-sm font-medium transition-colors ${historyTabClasses}`}
          onClick={() => onTabChange("history")}
        >
          <div className="flex items-center justify-center gap-2">
            <History className="w-4 h-4" />
            Moves
          </div>
        </button>
        <button
          className={`flex-1 py-2 lg:py-3 text-sm font-medium transition-colors ${chatTabClasses}`}
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
          <MoveListPanel
            formattedHistory={formattedHistory}
            historyNav={historyNav}
            hasNewMovesWhileRewound={hasNewMovesWhileRewound}
          />
        )}
      </div>
    </Card>
  );
}
