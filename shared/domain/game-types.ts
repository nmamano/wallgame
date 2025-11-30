// Core game types - shared between frontend and backend

/**
 * PLAYER TERMINOLOGY
 * ==================
 *
 * This codebase uses two distinct player identification systems:
 *
 * 1. PLAYER A / PLAYER B (Setup Page Terminology)
 *    - Used on the game setup page when configuring players
 *    - Player A is ALWAYS the host (game creator)
 *    - Player B is ALWAYS the joiner (second player)
 *    - Corresponds to the `role` field: "host" | "joiner"
 *    - In future variants, more players (C, D...) may be added
 *
 * 2. PLAYER 1 / PLAYER 2 (Game Logic Terminology)
 *    - Used during actual gameplay for turn order and board positions
 *    - Player 1 ALWAYS starts first (moves on turn 1, 3, 5...)
 *    - Player 1 ALWAYS has pawns on the left side of the board
 *    - Player 2 ALWAYS goes second (moves on turn 2, 4, 6...)
 *    - Player 2 ALWAYS has pawns on the right side of the board
 *    - Corresponds to the `PlayerId` type: 1 | 2
 *
 * WHO IS PLAYER 1?
 * ================
 * The assignment of which role (host/joiner) becomes Player 1 is determined:
 *
 * - Frontend-only games (bots, you vs you): The frontend randomly assigns
 *   which player slot becomes Player 1 at game start.
 *
 * - Backend games (friend, matchmaking): The host frontend randomly chooses
 *   and sends `hostIsPlayer1` when creating the game. The server uses this
 *   to assign PlayerId values to each role.
 */

export type PlayerId = 1 | 2;

export type Variant =
  | "standard" // Catch the mouse first
  | "classic"; // Reach the opposite corner first

export type TimeControlPreset =
  | "bullet" // 1+0
  | "blitz" // 3+2
  | "rapid" // 10+2
  | "classical"; // 30+0

export interface GameConfiguration {
  variant: Variant;
  timeControl: TimeControlConfig;
  rated: boolean;
  boardWidth: number;
  boardHeight: number;
}

// SessionStatus tracks the lifecycle of a game session/matchmaking
// - "waiting": waiting for players to join
// - "ready": both players ready, game can start
// - "in-progress": game has started
// - "completed": game finished normally
// - "aborted": session cancelled before completion

export type SessionStatus =
  | "waiting"
  | "ready"
  | "in-progress"
  | "completed"
  | "aborted";

// GameStatus tracks the actual game state from GameState
export type GameStatus = "playing" | "finished" | "aborted";

export interface PlayerAppearance {
  pawnColor?: string;
  catSkin?: string;
  mouseSkin?: string;
}

export interface GamePlayerSummary {
  role: "host" | "joiner"; // Creator vs joiner
  playerId: PlayerId;
  displayName: string;
  connected: boolean; // Whether player is currently connected via WebSocket
  ready: boolean; // Whether player has clicked "ready" in the matching stage. Both players must be ready before game starts.
  appearance?: PlayerAppearance;
  // TODO: consider adding rating here
}

// Match type determines how players join the game
export type MatchType = "friend" | "matchmaking";

export interface GameSnapshot {
  id: string;
  status: SessionStatus;
  config: GameConfiguration;
  matchType: MatchType;
  createdAt: number; // Timestamp (milliseconds since epoch) when the session was created
  updatedAt: number; // Timestamp (milliseconds since epoch) when the session was last updated
  players: GamePlayerSummary[];
}

export type WallOrientation = "vertical" | "horizontal";

export type PawnType = "cat" | "mouse";

// Cell represents a position on the board as [row, col]
export type Cell = [number, number];

// Action represents a single game action (cat move, mouse move, or wall placement)
export interface Action {
  type: "cat" | "mouse" | "wall";
  target: Cell;
  wallOrientation?: WallOrientation;
}

export interface Move {
  actions: Action[];
}

// Turn represents a pair of moves (one for each player in a turn)
export interface Turn {
  move1: Move;
  move2?: Move;
}

export type WinReason =
  | "capture"
  | "timeout"
  | "resignation"
  | "draw-agreement"
  | "one-move-rule"; // First-mover handicap rule

export interface GameResult {
  winner?: PlayerId;
  reason: WinReason;
}

/**
 * Represents a wall on the game board.
 *
 * Coordinate System:
 * - The board uses a 0-based, top-down coordinate system where (0,0) is the top-left corner
 * - Rows increase downward (row 0 is top, row N-1 is bottom)
 * - Columns increase rightward (col 0 is left, col N-1 is right)
 *
 * Wall Placement Semantics:
 * - The `cell` field specifies the cell coordinates where the wall is anchored (cell[0] = row, cell[1] = col)
 * - `orientation` determines the wall's direction:
 *
 *   VERTICAL ("vertical"):
 *   - Wall is placed to the RIGHT of the cell
 *   - Blocks movement between (cell[0], cell[1]) and (cell[0], cell[1]+1)
 *   - In standard notation: ">e4" means vertical wall to the right of cell e4
 *   - Visually: a vertical line separating two horizontally adjacent cells
 *
 *   HORIZONTAL ("horizontal"):
 *   - Wall is placed ABOVE the cell
 *   - Blocks movement between (cell[0]-1, cell[1]) and (cell[0], cell[1])
 *   - In standard notation: "^e4" means horizontal wall above cell e4
 *   - Visually: a horizontal line separating two vertically adjacent cells
 *   - Note: Since rows increase downward, "above" means cell[0]-1
 *
 * Examples:
 * - {cell: [4, 4], orientation: "vertical"} = vertical wall to the right of cell (4,4), blocking (4,4) ↔ (4,5)
 * - {cell: [4, 4], orientation: "horizontal"} = horizontal wall above cell (4,4), blocking (3,4) ↔ (4,4)
 */
export interface WallPosition {
  cell: Cell;
  orientation: WallOrientation;
  playerId?: PlayerId; // Who placed the wall
}

export interface TimeControlConfig {
  initialSeconds: number;
  incrementSeconds: number;
  preset?: TimeControlPreset;
}

export interface Pawn {
  playerId: PlayerId;
  type: PawnType;
  cell: Cell;
  pawnStyle?: string;
}

export type GameAction =
  | { kind: "move"; move: Move; playerId: PlayerId; timestamp: number }
  | { kind: "resign"; playerId: PlayerId; timestamp: number }
  | { kind: "timeout"; playerId: PlayerId; timestamp: number }
  | { kind: "draw"; playerId?: PlayerId; timestamp: number }
  | { kind: "takeback"; playerId?: PlayerId; timestamp: number }
  | {
      kind: "giveTime";
      playerId: PlayerId;
      seconds: number;
      timestamp: number;
    };

// Serialized game state sent over the wire (plain data structure for JSON serialization)
export interface SerializedGameState {
  status: GameStatus;
  result?: GameResult;
  turn: PlayerId;
  moveCount: number; // Global move counter, increments every turn (1, 2, 3...), not per-player
  timeLeft: Record<PlayerId, number>; // Milliseconds remaining for each player
  lastMoveTime: number; // Timestamp in milliseconds (milliseconds since epoch)
  pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;
  walls: WallPosition[];
  history: { index: number; notation: string }[]; // Move history: notation is a string representation (e.g., "Ce4.Md5.>f3") that can be parsed back into Move objects via Move.fromNotation()
  config: GameConfiguration;
}
