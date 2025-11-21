import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  MessageSquare,
  History,
  Flag,
  Handshake,
  RotateCcw,
  Clock,
  Volume2,
  VolumeX,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Timer,
  User,
  Bot,
  Trophy,
  Swords,
} from "lucide-react";
import { Board } from "@/components/board";
import { MatchingStagePanel, MatchingPlayer } from "@/components/matching-stage-panel";
import { Cell, Wall, Pawn } from "@/lib/game";
import { PlayerColor } from "@/lib/player-colors";
import { PlayerType } from "@/components/player-configuration";

export const Route = createFileRoute("/game/$id")({
  component: GamePage,
});

// --- Types ---

interface GamePlayer {
  id: string;
  name: string;
  rating: number;
  color: PlayerColor;
  type: PlayerType;
  isOnline: boolean;
  timeLeft: number; // seconds
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
  channel: "game" | "team" | "audience";
  isSystem?: boolean;
}

interface GameMove {
  number: number;
  notation: string;
  playerColor: PlayerColor;
}

// --- Mock Data Helpers ---

const MOCK_NAMES = ["Alice", "Bob", "Charlie", "Dave", "Eve"];

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function GamePage() {
  const { id } = Route.useParams();
  
  // --- State ---

  // Game Config & Players
  const [config, setConfig] = useState<any>(null);
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [matchingPlayers, setMatchingPlayers] = useState<MatchingPlayer[]>([]);
  const [isMatchingOpen, setIsMatchingOpen] = useState(true);
  
  // Game State
  const [gameStatus, setGameStatus] = useState<"matching" | "playing" | "finished">("matching");
  const [turn, setTurn] = useState<PlayerColor>("red");

  const [winner, setWinner] = useState<GamePlayer | null>(null);
  const [winReason, setWinReason] = useState<string>("");

  // Board State
  const [pawns, setPawns] = useState<Pawn[]>([]);
  const [walls, setWalls] = useState<Wall[]>([]);
  
  // UI State
  const [activeTab, setActiveTab] = useState<"chat" | "history">("chat");
  const [chatChannel, setChatChannel] = useState<"game" | "team" | "audience">("game");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<GameMove[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // --- Initialization ---

  useEffect(() => {
    // Simulate fetching game config
    let loadedConfig: any = {
      variant: "standard",
      rated: true,
      timeControl: "blitz",
      boardWidth: 9,
      boardHeight: 9,
    };
    
    let loadedPlayerConfigs: PlayerType[] = ["you", "easy-bot"];

    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem(`game-config-${id}`);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          loadedConfig = parsed.config;
          loadedPlayerConfigs = parsed.players;
        } catch (e) {
          console.error("Failed to parse game config", e);
        }
      }
    }

    setConfig(loadedConfig);

    // Setup Players
    const newPlayers: GamePlayer[] = [
      {
        id: "p1",
        name: "You",
        rating: 1200,
        color: "red",
        type: loadedPlayerConfigs[0],
        isOnline: true,
        timeLeft: loadedConfig.timeControl === "bullet" ? 60 : loadedConfig.timeControl === "blitz" ? 180 : 600,
      },
      {
        id: "p2",
        name: loadedPlayerConfigs[1] === "friend" ? "Friend" : 
              loadedPlayerConfigs[1] === "matched-user" ? "Opponent" : 
              "Bot " + loadedPlayerConfigs[1].split("-")[0],
        rating: 1250,
        color: "blue",
        type: loadedPlayerConfigs[1],
        isOnline: loadedPlayerConfigs[1].includes("bot"), // Bots are always online
        timeLeft: loadedConfig.timeControl === "bullet" ? 60 : loadedConfig.timeControl === "blitz" ? 180 : 600,
      }
    ];
    setPlayers(newPlayers);

    // Setup Matching State
    const mPlayers: MatchingPlayer[] = [
      {
        id: "p1",
        type: loadedPlayerConfigs[0],
        name: "You",
        isReady: true,
        isYou: true,
      },
      {
        id: "p2",
        type: loadedPlayerConfigs[1],
        name: newPlayers[1].name,
        isReady: loadedPlayerConfigs[1].includes("bot"), // Bots are ready immediately
        isYou: false,
      }
    ];
    setMatchingPlayers(mPlayers);

    // If all ready, start game
    if (mPlayers.every(p => p.isReady)) {
      setGameStatus("playing");
      setIsMatchingOpen(false);
      addSystemMessage("Game started!");
    } else {
      // Simulate opponent joining after a delay if waiting
      if (loadedPlayerConfigs[1] === "matched-user" || loadedPlayerConfigs[1] === "friend") {
        setTimeout(() => {
          setMatchingPlayers(prev => prev.map(p => p.id === "p2" ? { ...p, isReady: true } : p));
          setPlayers(prev => prev.map(p => p.id === "p2" ? { ...p, isOnline: true, name: MOCK_NAMES[Math.floor(Math.random() * MOCK_NAMES.length)] } : p));
          addSystemMessage("Opponent joined the game.");
          
          setTimeout(() => {
             setGameStatus("playing");
             setIsMatchingOpen(false);
             addSystemMessage("Game started!");
          }, 1000);
        }, 3000);
      }
    }

    // Initial Board Setup
    setPawns([
      { id: "pawn1", color: "red", type: "cat", cell: new Cell(loadedConfig.boardHeight - 1, Math.floor(loadedConfig.boardWidth / 2)) },
      { id: "pawn2", color: "blue", type: "cat", cell: new Cell(0, Math.floor(loadedConfig.boardWidth / 2)) }
    ]);

  }, [id]);

  // --- Game Logic Simulation ---

  // Timer Tick
  useEffect(() => {
    if (gameStatus !== "playing") return;

    const interval = setInterval(() => {
      setPlayers(prev => prev.map(p => {
        if (p.color === turn) {
          if (p.timeLeft <= 0) {
            handleGameOver(prev.find(op => op.color !== turn)!, "Timeout");
            return { ...p, timeLeft: 0 };
          }
          return { ...p, timeLeft: p.timeLeft - 1 };
        }
        return p;
      }));
    }, 1000);

    return () => clearInterval(interval);
  }, [gameStatus, turn]);

  // Bot Moves Simulation
  useEffect(() => {
    if (gameStatus !== "playing") return;

    const activePlayer = players.find(p => p.color === turn);
    if (activePlayer && activePlayer.type.includes("bot")) {
      const delay = Math.random() * 2000 + 1000;
      const timer = setTimeout(() => {
        makeRandomMove(activePlayer);
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [turn, gameStatus, players]);

  const makeRandomMove = (player: GamePlayer) => {
    // Mock move logic
    const moveType = Math.random() > 0.3 ? "move" : "wall";
    const notation = moveType === "move" ? "e5" : ">e4";
    if (moveType === "wall") {
      // Mock wall addition
      const newWall = new Wall(new Cell(4, 4), "vertical", "placed", player.color);
      setWalls(prev => [...prev, newWall]);
    }
    
    addHistory(player.color, notation);
    setTurn(prev => prev === "red" ? "blue" : "red");
    if (soundEnabled) playSound("move");
  };

  const handleGameOver = (winnerPlayer: GamePlayer, reason: string) => {
    setGameStatus("finished");
    setWinner(winnerPlayer);
    setWinReason(reason);
    addSystemMessage(`Game over! ${winnerPlayer.name} won by ${reason}.`);
  };

  const addSystemMessage = (text: string) => {
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      sender: "System",
      text,
      timestamp: new Date(),
      channel: "game",
      isSystem: true
    }]);
  };

  const addHistory = (color: PlayerColor, notation: string) => {
    setHistory(prev => [...prev, {
      number: Math.ceil((prev.length + 1) / 2),
      notation,
      playerColor: color
    }]);
  };

  const playSound = (_: "move" | "capture" | "check") => {
    // Placeholder for sound playing
  };

  // --- Handlers ---

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      sender: "You",
      text: chatInput,
      timestamp: new Date(),
      channel: chatChannel,
    }]);
    setChatInput("");
  };

  const handleAbort = () => {
    // Navigate back or show message
    window.history.back();
  };

  // --- Render Components ---

  const PlayerInfo = ({ player, isActive }: { player: GamePlayer, isActive: boolean, isTop?: boolean }) => (
    <div className={`flex items-center justify-between p-3 rounded-lg transition-colors ${isActive ? "bg-accent/50 border border-accent" : "bg-card/50 border border-border/50"}`}>
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${player.color === "red" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"}`}>
          {player.type.includes("bot") ? <Bot size={20} /> : <User size={20} />}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{player.name}</span>
            <Badge variant="outline" className="text-xs">{player.rating}</Badge>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className={`w-2 h-2 rounded-full ${player.isOnline ? "bg-green-500" : "bg-gray-300"}`} />
            {player.isOnline ? "Online" : "Offline"}
          </div>
        </div>
      </div>
      <div className={`text-2xl font-mono font-bold ${isActive ? "text-foreground" : "text-muted-foreground/50"} ${player.timeLeft < 30 ? "text-red-500 animate-pulse" : ""}`}>
        {formatTime(player.timeLeft)}
      </div>
    </div>
  );

  // Layout calculations
  const rows = config?.boardHeight || 9;
  const cols = config?.boardWidth || 9;
  
  // Board sizing constants (matching Board component internals)
  const maxCellSize = 3; // rem
  const gapSize = 0.9; // rem (gap between cells)
  const boardPadding = 2; // rem (p-4 = 1rem on each side)
  const containerMargin = 1; // rem (small margin for board container)
  
  // Calculate board dimensions
  const boardWidth = cols * maxCellSize + (cols - 1) * gapSize + boardPadding;
  const boardHeight = rows * maxCellSize + (rows - 1) * gapSize + boardPadding;
  
  // Calculate board container dimensions (board + margin)
  const boardContainerWidth = boardWidth + containerMargin * 2;
  
  // Minimum heights for adjustable components
  const minBoardContainerHeight = boardHeight + containerMargin * 2;
  const minChatScrollableHeight = 12; // rem - scrollable content area for ~3-4 chat messages
  
  // Fixed component heights
  const timerHeight = 4; // rem (approximate height of PlayerInfo component)
  const infoCardHeight = 6.5; // rem (approximate)
  const actionButtonsHeight = 5; // rem (approximate, 2 rows of buttons)
  const chatTabsHeight = 3; // rem (tabs header)
  const chatInputHeight = 4; // rem (chat input / move navigation fixed at bottom)
  const chatChannelsHeight = 2.5; // rem (chat channel selector)
  
  // Calculate gap size
  const gap = 1; // rem (reduced for tighter layout)
  
  // Right column max width
  const rightColumnMaxWidth = 25; // rem
  
  // Left column total height = timer + gap + board container + gap + timer
  const leftColumnHeight = timerHeight + gap + minBoardContainerHeight + gap + timerHeight;
  
  // Right column total height = info + gap + buttons + gap + chat card
  // Chat card total includes: tabs + (channels + scrollable content + input)
  const minChatCardHeight = chatTabsHeight + chatChannelsHeight + minChatScrollableHeight + chatInputHeight;
  const rightColumnHeight = infoCardHeight + gap + actionButtonsHeight + gap + minChatCardHeight;
  
  // Determine which component needs to grow to match column heights
  const heightDiff = leftColumnHeight - rightColumnHeight;
  const adjustedBoardContainerHeight = heightDiff < 0 ? minBoardContainerHeight - heightDiff : minBoardContainerHeight;
  // When chat card grows, only the scrollable content area grows (not tabs, channels, or input)
  const adjustedChatScrollableHeight = heightDiff > 0 ? minChatScrollableHeight + heightDiff : minChatScrollableHeight;
  const adjustedChatCardHeight = chatTabsHeight + chatChannelsHeight + adjustedChatScrollableHeight + chatInputHeight;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <MatchingStagePanel 
        isOpen={isMatchingOpen} 
        players={matchingPlayers} 
        gameUrl={typeof window !== "undefined" ? window.location.href : ""}
        onAbort={handleAbort}
      />

      <div 
        className="flex-1 py-4 px-4"
        style={{
          display: 'grid',
          gridTemplateColumns: `${boardContainerWidth}rem ${rightColumnMaxWidth}rem`,
          gap: `${gap}rem`,
          alignItems: 'start',
          justifyContent: 'center',
          margin: '0 auto',
          width: 'fit-content',
        }}
      >
        
        {/* Left Column: Timers & Board */}
        <div 
          className="flex flex-col"
          style={{
            width: `${boardContainerWidth}rem`,
            gap: `${gap}rem`,
          }}
        >
          {/* Top Player (Opponent) Timer */}
          {players.length > 1 && <PlayerInfo player={players[1]} isActive={turn === players[1].color} isTop />}

          {/* Board Container */}
          <div 
            className="flex items-center justify-center bg-card/30 rounded-xl border border-border/30 p-4 relative"
            style={{
              minHeight: `${adjustedBoardContainerHeight}rem`,
              height: `${adjustedBoardContainerHeight}rem`,
            }}
          >
            {/* Game Over Overlay */}
            {gameStatus === "finished" && winner && (
              <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center rounded-xl">
                <Card className="p-8 max-w-md w-full text-center space-y-6 shadow-2xl border-primary/20">
                  <Trophy className="w-16 h-16 mx-auto text-yellow-500" />
                  <div>
                    <h2 className="text-3xl font-bold mb-2">{winner.name} Won!</h2>
                    <p className="text-muted-foreground text-lg">by {winReason}</p>
                  </div>
                  <div className="flex justify-center gap-4">
                    <Button onClick={() => window.location.reload()}>Rematch</Button>
                    <Button variant="outline" onClick={() => window.history.back()}>Exit</Button>
                  </div>
                </Card>
              </div>
            )}

            <Board 
              rows={rows}
              cols={cols}
              pawns={pawns}
              walls={walls}
              className="p-0"
              maxWidth="max-w-full"
            />
          </div>

          {/* Bottom Player (You) Timer */}
          {players.length > 0 && <PlayerInfo player={players[0]} isActive={turn === players[0].color} />}
        </div>

        {/* Right Column: Info, Actions & Chat */}
        <div 
          className="flex flex-col"
          style={{
            gap: `${gap}rem`,
            maxWidth: `${rightColumnMaxWidth}rem`,
          }}
        >
          {/* Game Info Card */}
          <Card className="p-4 space-y-3 bg-card/50 backdrop-blur">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Swords className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium capitalize">{config?.variant}</span>
              </div>
              <Badge variant={config?.rated ? "default" : "secondary"}>
                {config?.rated ? "Rated" : "Casual"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span className="capitalize">{config?.timeControl}</span>
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-6 w-6"
                onClick={() => setSoundEnabled(!soundEnabled)}
              >
                {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </Button>
            </div>
          </Card>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="w-full justify-start gap-2" size="sm">
              <Flag className="w-4 h-4" /> Resign
            </Button>
            <Button variant="outline" className="w-full justify-start gap-2" size="sm">
              <Handshake className="w-4 h-4" /> Draw
            </Button>
            <Button variant="outline" className="w-full justify-start gap-2" size="sm">
              <RotateCcw className="w-4 h-4" /> Takeback
            </Button>
            <Button variant="outline" className="w-full justify-start gap-2" size="sm">
              <Timer className="w-4 h-4" /> Give time
            </Button>
          </div>

          {/* Chat/Moves Panel */}
          <Card 
            className="flex flex-col overflow-hidden bg-card/50 backdrop-blur"
            style={{
              height: `${adjustedChatCardHeight}rem`,
              minHeight: `${adjustedChatCardHeight}rem`,
            }}
          >
            <div className="flex border-b flex-shrink-0">
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === "chat" ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setActiveTab("chat")}
              >
                <div className="flex items-center justify-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  Chat
                </div>
              </button>
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === "history" ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setActiveTab("history")}
              >
                <div className="flex items-center justify-center gap-2">
                  <History className="w-4 h-4" />
                  Moves
                </div>
              </button>
            </div>

            <div className="flex-1 overflow-hidden relative flex flex-col">
              {activeTab === "chat" ? (
                <>
                  {/* Chat Channels */}
                  <div className="flex p-2 gap-1 bg-muted/30 flex-shrink-0">
                    {(["game", "team", "audience"] as const).map((c) => (
                      <button
                        key={c}
                        onClick={() => setChatChannel(c)}
                        className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${chatChannel === c ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                      >
                        {c.charAt(0).toUpperCase() + c.slice(1)}
                      </button>
                    ))}
                  </div>
                  
                  {/* Messages */}
                  <ScrollArea className="flex-1 p-4">
                    <div className="space-y-3">
                      {messages
                        .filter(m => m.channel === chatChannel || m.isSystem)
                        .map((msg) => (
                        <div key={msg.id} className={`flex flex-col ${msg.sender === "You" ? "items-end" : "items-start"}`}>
                          {!msg.isSystem && (
                            <span className="text-[10px] text-muted-foreground mb-1">{msg.sender}</span>
                          )}
                          <div className={`px-3 py-2 rounded-lg text-sm max-w-[85%] ${
                            msg.isSystem ? "bg-muted text-muted-foreground text-center w-full italic" :
                            msg.sender === "You" ? "bg-primary text-primary-foreground" : "bg-muted"
                          }`}>
                            {msg.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>

                  {/* Input */}
                  <form onSubmit={handleSendMessage} className="p-3 border-t bg-background/50 flex-shrink-0">
                    <Input 
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={`Message ${chatChannel}...`}
                      className="bg-background"
                    />
                  </form>
                </>
              ) : (
                <>
                  <ScrollArea className="flex-1 p-0">
                    <div className="grid grid-cols-[3rem_1fr_1fr] text-sm">
                      {history.reduce((acc: any[], move, i) => {
                        if (i % 2 === 0) {
                          acc.push({ num: move.number, white: move, black: null });
                        } else {
                          acc[acc.length - 1].black = move;
                        }
                        return acc;
                      }, []).map((row, i) => (
                        <div key={i} className={`contents group ${i % 2 === 1 ? "bg-muted/30" : ""}`}>
                          <div className="p-2 text-muted-foreground text-center border-r">{row.num}.</div>
                          <button className="p-2 hover:bg-accent text-center transition-colors border-r font-mono">{row.white?.notation}</button>
                          <button className="p-2 hover:bg-accent text-center transition-colors font-mono">{row.black?.notation}</button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                  
                  {/* History Controls */}
                  <div className="p-2 border-t grid grid-cols-4 gap-1 bg-muted/30 flex-shrink-0">
                    <Button variant="ghost" size="icon" className="h-8"><ChevronsLeft className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" className="h-8"><ChevronLeft className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" className="h-8"><ChevronRight className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" className="h-8"><ChevronsRight className="w-4 h-4" /></Button>
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
