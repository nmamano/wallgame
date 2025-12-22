import type {
  PlayerId,
  GameStatus,
  GameResult,
  Cell,
  WallPosition,
  Move,
  TimeControlConfig,
  GameConfiguration,
  Pawn,
  GameAction,
} from "./game-types";
import { Grid } from "./grid";
import { cellEq } from "./game-utils";

export interface MoveInHistory {
  index: number;
  move: Move;
  grid: Grid;
  catPos: [Cell, Cell];
  mousePos: [Cell, Cell];
  timeLeftSeconds: [number, number];
  distances: [number, number];
  wallCounts: [number, number];
}

export class GameState {
  grid: Grid;
  pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;
  turn: PlayerId;
  moveCount: number; // Completed moves count (0 before any moves)

  history: MoveInHistory[];
  status: GameStatus;
  result?: GameResult;

  timeControl: TimeControlConfig;
  timeLeft: Record<PlayerId, number>; // Seconds with 0.1s resolution
  lastMoveTime: number;

  config: GameConfiguration;

  // Initial state for undoing the first move
  private initialGrid: Grid;
  private initialPawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;

  constructor(config: GameConfiguration, startTime: number) {
    this.config = config;
    this.grid = new Grid(config.boardWidth, config.boardHeight, config.variant);

    const rows = config.boardHeight;
    const cols = config.boardWidth;

    // Always use default starting positions
    // Cats start at top (row 0), mice start at bottom (row rows-1)
    this.pawns = {
      1: {
        cat: [0, 0],
        mouse: [rows - 1, 0],
      },
      2: {
        cat: [0, cols - 1],
        mouse: [rows - 1, cols - 1],
      },
    };

    // Save initial state
    this.initialGrid = this.grid.clone();
    this.initialPawns = {
      1: { ...this.pawns[1] },
      2: { ...this.pawns[2] },
    };

    this.turn = 1;
    this.moveCount = 0;
    this.history = [];
    this.status = "playing";

    this.timeControl = config.timeControl;
    this.timeLeft = {
      1: config.timeControl.initialSeconds,
      2: config.timeControl.initialSeconds,
    };
    this.lastMoveTime = startTime;
  }

  clone(): GameState {
    const newGame = new GameState(this.config, this.lastMoveTime);
    newGame.grid = this.grid.clone();
    newGame.pawns = {
      1: { ...this.pawns[1] },
      2: { ...this.pawns[2] },
    };
    newGame.turn = this.turn;
    newGame.moveCount = this.moveCount;
    newGame.history = [...this.history];
    newGame.status = this.status;
    newGame.result = this.result ? { ...this.result } : undefined;
    newGame.timeLeft = { ...this.timeLeft };
    newGame.initialGrid = this.initialGrid.clone();
    newGame.initialPawns = {
      1: { ...this.initialPawns[1] },
      2: { ...this.initialPawns[2] },
    };
    return newGame;
  }

  applyGameAction(action: GameAction): GameState {
    const nextState = this.clone();
    nextState.applyGameActionMutable(action);
    return nextState;
  }

  private applyGameActionMutable(action: GameAction): void {
    if (this.status !== "playing") {
      throw new Error("Game is not playing");
    }

    if (action.kind === "move") {
      if (action.playerId !== this.turn) {
        throw new Error("Not your turn");
      }
      // Start the clock on the first move; don't penalize pre-move waiting time.
      const elapsed =
        this.moveCount === 0
          ? 0
          : (action.timestamp - this.lastMoveTime) / 1000;
      // Deduct time, ensuring 0.1s resolution (rounding down/up? usually floor or just float)
      // Let's keep it as float for accuracy, but display/store rounded if needed.
      this.timeLeft[this.turn] = Math.max(
        0,
        this.timeLeft[this.turn] - elapsed,
      );
    }

    switch (action.kind) {
      case "move":
        this.applyMove(action.move, action.timestamp);
        break;
      case "resign":
        this.status = "finished";
        this.result = {
          winner: action.playerId === 1 ? 2 : 1,
          reason: "resignation",
        };
        break;
      case "timeout":
        this.status = "finished";
        this.result = {
          winner: action.playerId === 1 ? 2 : 1,
          reason: "timeout",
        };
        break;
      case "draw":
        this.status = "finished";
        this.result = {
          reason: "draw-agreement",
        };
        break;
      case "takeback":
        this.undoTakebackForPlayer(action.playerId);
        break;
      case "giveTime": {
        const opponent = action.playerId === 1 ? 2 : 1;
        this.timeLeft[opponent] += action.seconds;
        break;
      }
    }
  }

  private applyMove(move: Move, timestamp: number) {
    const player = this.turn;
    const opponent = player === 1 ? 2 : 1;
    const myPawns = this.pawns[player];
    const opPawns = this.pawns[opponent];

    const nextGrid = this.grid.clone();
    const nextMyPawns = {
      cat: [myPawns.cat[0], myPawns.cat[1]] as Cell,
      mouse: [myPawns.mouse[0], myPawns.mouse[1]] as Cell,
    };

    for (const action of move.actions) {
      if (action.type === "cat" || action.type === "mouse") {
        const currentPos =
          action.type === "cat" ? nextMyPawns.cat : nextMyPawns.mouse;
        const targetPos = action.target;

        const dist =
          Math.abs(currentPos[0] - targetPos[0]) +
          Math.abs(currentPos[1] - targetPos[1]);

        if (dist === 1) {
          // Single step
          // Check wall blocking
          // Moving from currentPos to targetPos
          // Determine direction
          if (targetPos[1] > currentPos[1]) {
            // Right
            if (nextGrid.hasWall({ cell: currentPos, orientation: "vertical" }))
              throw new Error("Move blocked by wall");
          } else if (targetPos[1] < currentPos[1]) {
            // Left
            if (nextGrid.hasWall({ cell: targetPos, orientation: "vertical" }))
              throw new Error("Move blocked by wall");
          } else if (targetPos[0] > currentPos[0]) {
            // Down (row increases)
            if (
              nextGrid.hasWall({ cell: targetPos, orientation: "horizontal" })
            )
              throw new Error("Move blocked by wall");
          } else if (targetPos[0] < currentPos[0]) {
            // Up (row decreases)
            if (
              nextGrid.hasWall({ cell: currentPos, orientation: "horizontal" })
            )
              throw new Error("Move blocked by wall");
          }
        } else if (dist === 2) {
          // Double step (allowed if there is a valid intermediate square)
          // Find intermediate square
          let validPathFound = false;

          // Possible intermediate squares
          const candidates: Cell[] = [];
          if (currentPos[0] === targetPos[0]) {
            // Horizontal move (e.g. a1 -> c1, mid is b1)
            candidates.push([
              currentPos[0],
              (currentPos[1] + targetPos[1]) / 2,
            ]);
          } else if (currentPos[1] === targetPos[1]) {
            // Vertical move
            candidates.push([
              (currentPos[0] + targetPos[0]) / 2,
              currentPos[1],
            ]);
          } else {
            // Diagonal (L-shape)
            candidates.push([currentPos[0], targetPos[1]]);
            candidates.push([targetPos[0], currentPos[1]]);
          }

          for (const mid of candidates) {
            // Check step 1: current -> mid
            let step1Valid = true;
            if (mid[1] > currentPos[1]) {
              if (
                nextGrid.hasWall({ cell: currentPos, orientation: "vertical" })
              )
                step1Valid = false;
            } else if (mid[1] < currentPos[1]) {
              if (nextGrid.hasWall({ cell: mid, orientation: "vertical" }))
                step1Valid = false;
            } else if (mid[0] > currentPos[0]) {
              if (nextGrid.hasWall({ cell: mid, orientation: "horizontal" }))
                step1Valid = false;
            } else if (mid[0] < currentPos[0]) {
              if (
                nextGrid.hasWall({
                  cell: currentPos,
                  orientation: "horizontal",
                })
              )
                step1Valid = false;
            }

            if (!step1Valid) continue;

            // Check step 2: mid -> target
            let step2Valid = true;
            if (targetPos[1] > mid[1]) {
              if (nextGrid.hasWall({ cell: mid, orientation: "vertical" }))
                step2Valid = false;
            } else if (targetPos[1] < mid[1]) {
              if (
                nextGrid.hasWall({ cell: targetPos, orientation: "vertical" })
              )
                step2Valid = false;
            } else if (targetPos[0] > mid[0]) {
              if (
                nextGrid.hasWall({ cell: targetPos, orientation: "horizontal" })
              )
                step2Valid = false;
            } else if (targetPos[0] < mid[0]) {
              if (nextGrid.hasWall({ cell: mid, orientation: "horizontal" }))
                step2Valid = false;
            }

            if (step2Valid) {
              validPathFound = true;
              break;
            }
          }

          if (!validPathFound)
            throw new Error("Invalid double move: blocked or no path");
        } else {
          throw new Error("Invalid move distance");
        }

        if (action.type === "cat") nextMyPawns.cat = targetPos;
        else nextMyPawns.mouse = targetPos;
      } else if (action.type === "wall") {
        const wall: WallPosition = {
          cell: action.target,
          orientation: action.wallOrientation!,
        };

        const wallWithPlayer: WallPosition = {
          ...wall,
          playerId: player,
        };

        console.info("[debug-wall] before addWall", {
          playerId: player,
          wall: wallWithPlayer,
          wallsBefore: nextGrid.getWalls(),
        });

        const pendingPawns = {
          1: player === 1 ? nextMyPawns : opPawns,
          2: player === 2 ? nextMyPawns : opPawns,
        };
        const cats: [Cell, Cell] = [
          [pendingPawns[1].cat[0], pendingPawns[1].cat[1]],
          [pendingPawns[2].cat[0], pendingPawns[2].cat[1]],
        ];
        const mice: [Cell, Cell] = [
          [pendingPawns[1].mouse[0], pendingPawns[1].mouse[1]],
          [pendingPawns[2].mouse[0], pendingPawns[2].mouse[1]],
        ];

        if (!nextGrid.canBuildWall(cats, mice, wall)) {
          throw new Error("Illegal wall placement");
        }

        nextGrid.addWall(wallWithPlayer);

        console.info("[debug-wall] after addWall", {
          playerId: player,
          wallsAfter: nextGrid.getWalls(),
        });
      }
    }

    const myCatCaught = cellEq(nextMyPawns.cat, opPawns.mouse);
    const opCatCaught = cellEq(opPawns.cat, nextMyPawns.mouse);

    // Update timeLeft with increment
    const nextTimeLeft = { ...this.timeLeft };
    nextTimeLeft[player] += this.timeControl.incrementSeconds;

    const nextPawns = {
      1: player === 1 ? nextMyPawns : opPawns,
      2: player === 2 ? nextMyPawns : opPawns,
    };

    const nextMoveIndex = this.moveCount + 1;
    const moveInHistory: MoveInHistory = {
      index: nextMoveIndex,
      move: move,
      grid: nextGrid.clone(),
      catPos: [
        [nextPawns[1].cat[0], nextPawns[1].cat[1]],
        [nextPawns[2].cat[0], nextPawns[2].cat[1]],
      ],
      mousePos: [
        [nextPawns[1].mouse[0], nextPawns[1].mouse[1]],
        [nextPawns[2].mouse[0], nextPawns[2].mouse[1]],
      ],
      timeLeftSeconds: [nextTimeLeft[1], nextTimeLeft[2]],
      distances: [0, 0],
      wallCounts: [0, 0],
    };
    this.history.push(moveInHistory);

    this.grid = nextGrid;
    this.pawns = nextPawns;
    this.timeLeft = nextTimeLeft;
    this.lastMoveTime = timestamp;

    if (myCatCaught) {
      if (player === 1) {
        const dist = this.grid.distance(
          [opPawns.cat[0], opPawns.cat[1]],
          [nextMyPawns.mouse[0], nextMyPawns.mouse[1]],
        );
        if (dist <= 2 && dist !== -1) {
          this.status = "finished";
          this.result = { reason: "one-move-rule" };
          return;
        }
      }

      this.status = "finished";
      this.result = {
        winner: player,
        reason: "capture",
      };
      return;
    }

    if (opCatCaught) {
      this.status = "finished";
      this.result = {
        winner: opponent,
        reason: "capture",
      };
      return;
    }

    this.turn = opponent;
    this.moveCount = nextMoveIndex;
  }

  /**
   * Undo moves to take back the requesting player's last move.
   * The accepterId is the player who accepted the takeback (passed in action).
   * The requester is the opponent of the accepter.
   * If the opponent moved after the requester, both moves are undone.
   */
  private undoTakebackForPlayer(accepterId: PlayerId) {
    if (this.history.length === 0) return;

    // The requester is the opponent of the accepter
    const requesterId: PlayerId = accepterId === 1 ? 2 : 1;

    // If it's the requester's turn, the accepter (opponent) moved last,
    // so we need to undo 2 moves (accepter's move + requester's move)
    // If it's the accepter's turn, requester moved last,
    // so we only need to undo 1 move (requester's move)
    const movesToUndo = this.turn === requesterId ? 2 : 1;

    for (let i = 0; i < movesToUndo && this.history.length > 0; i++) {
      this.undoLastMove();
    }
  }

  private undoLastMove() {
    if (this.history.length === 0) return;
    this.history.pop();

    let prevGrid: Grid;
    let prevPawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;
    let prevTimeLeft: Record<PlayerId, number>;

    if (this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      prevGrid = last.grid;
      prevPawns = {
        1: {
          cat: [last.catPos[0][0], last.catPos[0][1]],
          mouse: [last.mousePos[0][0], last.mousePos[0][1]],
        },
        2: {
          cat: [last.catPos[1][0], last.catPos[1][1]],
          mouse: [last.mousePos[1][0], last.mousePos[1][1]],
        },
      };
      prevTimeLeft = {
        1: last.timeLeftSeconds[0],
        2: last.timeLeftSeconds[1],
      };
      this.moveCount = last.index;
    } else {
      prevGrid = this.initialGrid.clone();
      prevPawns = {
        1: { ...this.initialPawns[1] },
        2: { ...this.initialPawns[2] },
      };
      prevTimeLeft = {
        1: this.config.timeControl.initialSeconds,
        2: this.config.timeControl.initialSeconds,
      };
      this.moveCount = 0;
    }

    this.grid = prevGrid;
    this.pawns = prevPawns;
    this.timeLeft = prevTimeLeft;

    this.turn = this.turn === 1 ? 2 : 1;
    this.status = "playing";
    this.result = undefined;
  }

  getPawns(): Pawn[] {
    return [
      { playerId: 1, type: "cat", cell: this.pawns[1].cat },
      { playerId: 1, type: "mouse", cell: this.pawns[1].mouse },
      { playerId: 2, type: "cat", cell: this.pawns[2].cat },
      { playerId: 2, type: "mouse", cell: this.pawns[2].mouse },
    ];
  }
}
