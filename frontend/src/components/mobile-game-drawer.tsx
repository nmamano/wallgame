import { useState } from "react";
import { History, MessageSquare, Settings2 } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";
import { MoveListPanel } from "@/components/move-list-panel";
import { GameChatPanel, type ChatMessage } from "@/components/game-chat-panel";
import { GameInfoPanel } from "@/components/game-info-panel";
import type { MoveHistoryRow } from "@/components/move-list-panel";
import type { HistoryNav } from "@/types/history";
import type { GameConfiguration } from "../../../shared/domain/game-types";
import type { EvalToggleState } from "@/hooks/use-eval-bar";
import type { PlayerType } from "@/lib/gameViewModel";

type DrawerTab = "moves" | "chat" | "info";

interface MobileGameDrawerProps {
  // Move list props
  formattedHistory: MoveHistoryRow[];
  historyNav: HistoryNav;
  hasNewMovesWhileRewound: boolean;
  historyTabHighlighted: boolean;
  chatTabHighlighted: boolean;

  // Chat props
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

  // Game info props
  config: GameConfiguration | null;
  defaultVariant: string;
  defaultTimeControlPreset: string | null | undefined;
  sfxEnabled: boolean;
  onSfxToggle: () => void;
  musicEnabled: boolean;
  onMusicToggle: () => void;
  interactionLocked: boolean;
  isMultiplayerMatch: boolean;
  unsupportedPlayers: PlayerType[];
  placeholderCopy: Partial<Record<PlayerType, string>>;
  evalToggleState: EvalToggleState;
  evalToggleDisabled: boolean;
  evalToggleDisabledReason?: string;
  onEvalToggle: () => void;
  evalErrorMessage?: string | null;
}

/**
 * Bottom-sheet drawer for mobile game page.
 * Contains three tabs: Moves, Chat, and Info.
 * The tab bar is always visible; tapping a tab opens the drawer.
 */
export function MobileGameDrawer(props: MobileGameDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DrawerTab>("moves");

  const openTab = (tab: DrawerTab) => {
    setActiveTab(tab);
    setIsOpen(true);
  };

  const tabButtonClass = (tab: DrawerTab, highlighted: boolean) => {
    const isActive = isOpen && activeTab === tab;
    const base = "flex items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer rounded-md";
    if (isActive) return `${base} text-primary bg-primary/10`;
    if (highlighted) return `${base} text-primary animate-pulse`;
    return `${base} text-muted-foreground hover:text-foreground`;
  };

  return (
    <>
      {/* Tab bar — always visible at the bottom of the mobile layout */}
      <div className="flex items-center justify-center gap-2 w-full py-1 bg-card/90 backdrop-blur border-t border-border">
        <button className={tabButtonClass("moves", props.historyTabHighlighted)} onClick={() => openTab("moves")}>
          <History className="w-3.5 h-3.5" />
          Moves
        </button>
        <button className={tabButtonClass("chat", props.chatTabHighlighted)} onClick={() => openTab("chat")}>
          <MessageSquare className="w-3.5 h-3.5" />
          Chat
        </button>
        <button className={tabButtonClass("info", false)} onClick={() => openTab("info")}>
          <Settings2 className="w-3.5 h-3.5" />
          Info
        </button>
      </div>

      {/* Vaul drawer */}
      <Drawer open={isOpen} onOpenChange={setIsOpen}>
        <DrawerContent className="max-h-[70dvh]">
          <DrawerTitle className="sr-only">Game Details</DrawerTitle>

          {/* Tab switcher inside drawer */}
          <div className="flex border-b shrink-0">
            {(["moves", "chat", "info"] as const).map((tab) => (
              <button
                key={tab}
                className={`flex-1 py-2 text-sm font-medium transition-colors cursor-pointer ${
                  activeTab === tab
                    ? "border-b-2 border-primary text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === "moves" && (
                  <span className="flex items-center justify-center gap-1.5">
                    <History className="w-4 h-4" /> Moves
                  </span>
                )}
                {tab === "chat" && (
                  <span className="flex items-center justify-center gap-1.5">
                    <MessageSquare className="w-4 h-4" /> Chat
                  </span>
                )}
                {tab === "info" && (
                  <span className="flex items-center justify-center gap-1.5">
                    <Settings2 className="w-4 h-4" /> Info
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {activeTab === "moves" && (
              <MoveListPanel
                formattedHistory={props.formattedHistory}
                historyNav={props.historyNav}
                hasNewMovesWhileRewound={props.hasNewMovesWhileRewound}
              />
            )}
            {activeTab === "chat" && (
              <GameChatPanel
                chatChannel={props.chatChannel}
                messages={props.messages}
                chatInput={props.chatInput}
                onChannelChange={props.onChannelChange}
                onInputChange={props.onInputChange}
                onSendMessage={props.onSendMessage}
                isSpectator={props.isSpectator}
                isReplay={props.isReplay}
                isTeamVariant={props.isTeamVariant}
                isSending={props.isSending}
                isOnlineGame={props.isOnlineGame}
              />
            )}
            {activeTab === "info" && (
              <div className="p-3">
                <GameInfoPanel
                  config={props.config}
                  defaultVariant={props.defaultVariant}
                  defaultTimeControlPreset={props.defaultTimeControlPreset}
                  sfxEnabled={props.sfxEnabled}
                  onSfxToggle={props.onSfxToggle}
                  musicEnabled={props.musicEnabled}
                  onMusicToggle={props.onMusicToggle}
                  interactionLocked={props.interactionLocked}
                  isMultiplayerMatch={props.isMultiplayerMatch}
                  unsupportedPlayers={props.unsupportedPlayers}
                  placeholderCopy={props.placeholderCopy}
                  evalToggleState={props.evalToggleState}
                  evalToggleDisabled={props.evalToggleDisabled}
                  evalToggleDisabledReason={props.evalToggleDisabledReason}
                  onEvalToggle={props.onEvalToggle}
                  evalErrorMessage={props.evalErrorMessage}
                />
              </div>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
