import {
  Grid,
  Move,
  Cell,
  Pawn,
  TimeControl,
  MoveInHistory,
  createCell,
  Wall,
  PlayerId,
  PlayerWall,
} from "./game";

export type GameStatus = "playing" | "finished" | "aborted";

export type WinReason =
  | "capture"
  | "timeout"
  | "resignation"
  | "draw-agreement"
  | "one-move-rule"
  | "stalemate";

export interface GameResult {
  winner?: PlayerId; // undefined if draw
  reason: WinReason;
}

export interface GameConfig {
  boardWidth: number;
  boardHeight: number;
  variant: "Standard" | "Classic" | "Freestyle";
  timeControl: TimeControl;
  startPos?: {
    p1Cat: string;
    p1Mouse: string;
    p2Cat: string;
    p2Mouse: string;
  };
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

export class GameState {
  grid: Grid;
  pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;
  turn: PlayerId;
  moveCount: number; // Increments every turn (1, 2, 3...)

  history: MoveInHistory[];
  status: GameStatus;
  result?: GameResult;

  timeControl: TimeControl;
  timeLeft: Record<PlayerId, number>; // Seconds with 0.1s resolution
  lastMoveTime: number;

  config: GameConfig;

  // Initial state for undoing the first move
  private initialGrid: Grid;
  private initialPawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;

  constructor(config: GameConfig, startTime: number) {
    this.config = config;
    this.grid = new Grid(config.boardWidth, config.boardHeight);
    this.grid.variant = config.variant;

    const rows = config.boardHeight;
    const cols = config.boardWidth;

    this.pawns = {
      1: {
        cat: config.startPos
          ? createCell(config.startPos.p1Cat, rows)
          : new Cell(rows - 1, 0),
        mouse: config.startPos
          ? createCell(config.startPos.p1Mouse, rows)
          : new Cell(0, 0),
      },
      2: {
        cat: config.startPos
          ? createCell(config.startPos.p2Cat, rows)
          : new Cell(rows - 1, cols - 1),
        mouse: config.startPos
          ? createCell(config.startPos.p2Mouse, rows)
          : new Cell(0, cols - 1),
      },
    };

    // Save initial state
    this.initialGrid = this.grid.clone();
    this.initialPawns = {
      1: { ...this.pawns[1] },
      2: { ...this.pawns[2] },
    };

    this.turn = 1;
    this.moveCount = 1;
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

    if (action.kind !== "timeout" && action.kind !== "giveTime") {
      const elapsed = (action.timestamp - this.lastMoveTime) / 1000;
      if (action.kind === "move") {
        if (action.playerId !== this.turn) {
          throw new Error("Not your turn");
        }
        // Deduct time, ensuring 0.1s resolution (rounding down/up? usually floor or just float)
        // Let's keep it as float for accuracy, but display/store rounded if needed.
        this.timeLeft[this.turn] = Math.max(
          0,
          this.timeLeft[this.turn] - elapsed
        );
      }
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
        this.undoLastMove();
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
    const nextMyPawns = { ...myPawns };

    for (const action of move.actions) {
      if (action.type === "cat" || action.type === "mouse") {
        const currentPos =
          action.type === "cat" ? nextMyPawns.cat : nextMyPawns.mouse;
        const targetPos = action.target;

        const dist =
          Math.abs(currentPos.row - targetPos.row) +
          Math.abs(currentPos.col - targetPos.col);

        if (dist === 1) {
          // Single step
          // Check wall blocking
          // Moving from currentPos to targetPos
          // Determine direction
          if (targetPos.col > currentPos.col) {
            // Right
            if (nextGrid.hasWall(currentPos, "vertical"))
              throw new Error("Move blocked by wall");
          } else if (targetPos.col < currentPos.col) {
            // Left
            if (nextGrid.hasWall(targetPos, "vertical"))
              throw new Error("Move blocked by wall");
          } else if (targetPos.row > currentPos.row) {
            // Down (row increases)
            if (nextGrid.hasWall(targetPos, "horizontal"))
              throw new Error("Move blocked by wall");
          } else if (targetPos.row < currentPos.row) {
            // Up (row decreases)
            if (nextGrid.hasWall(currentPos, "horizontal"))
              throw new Error("Move blocked by wall");
          }
        } else if (dist === 2) {
          // Double step (allowed if there is a valid intermediate square)
          // Find intermediate square
          let validPathFound = false;

          // Possible intermediate squares
          const candidates: Cell[] = [];
          if (currentPos.row === targetPos.row) {
            // Horizontal move (e.g. a1 -> c1, mid is b1)
            candidates.push(
              new Cell(currentPos.row, (currentPos.col + targetPos.col) / 2)
            );
          } else if (currentPos.col === targetPos.col) {
            // Vertical move
            candidates.push(
              new Cell((currentPos.row + targetPos.row) / 2, currentPos.col)
            );
          } else {
            // Diagonal (L-shape)
            candidates.push(new Cell(currentPos.row, targetPos.col));
            candidates.push(new Cell(targetPos.row, currentPos.col));
          }

          for (const mid of candidates) {
            // Check step 1: current -> mid
            let step1Valid = true;
            if (mid.col > currentPos.col) {
              if (nextGrid.hasWall(currentPos, "vertical")) step1Valid = false;
            } else if (mid.col < currentPos.col) {
              if (nextGrid.hasWall(mid, "vertical")) step1Valid = false;
            } else if (mid.row > currentPos.row) {
              if (nextGrid.hasWall(mid, "horizontal")) step1Valid = false;
            } else if (mid.row < currentPos.row) {
              if (nextGrid.hasWall(currentPos, "horizontal"))
                step1Valid = false;
            }

            if (!step1Valid) continue;

            // Check step 2: mid -> target
            let step2Valid = true;
            if (targetPos.col > mid.col) {
              if (nextGrid.hasWall(mid, "vertical")) step2Valid = false;
            } else if (targetPos.col < mid.col) {
              if (nextGrid.hasWall(targetPos, "vertical")) step2Valid = false;
            } else if (targetPos.row > mid.row) {
              if (nextGrid.hasWall(targetPos, "horizontal")) step2Valid = false;
            } else if (targetPos.row < mid.row) {
              if (nextGrid.hasWall(mid, "horizontal")) step2Valid = false;
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
        const cats: [[number, number], [number, number]] = [
          [nextMyPawns.cat.row, nextMyPawns.cat.col],
          [opPawns.cat.row, opPawns.cat.col],
        ];
        const mice: [[number, number], [number, number]] = [
          [opPawns.mouse.row, opPawns.mouse.col],
          [nextMyPawns.mouse.row, nextMyPawns.mouse.col],
        ];

        const wall = new Wall(action.target, action.wallOrientation!);

        if (!nextGrid.canBuildWall(cats, mice, wall)) {
          throw new Error("Invalid wall placement: blocks path or overlaps");
        }
        nextGrid.addWall(wall, player);
      }
    }

    const myCatCaught = nextMyPawns.cat.equals(opPawns.mouse);
    const opCatCaught = opPawns.cat.equals(nextMyPawns.mouse);

    // Update timeLeft with increment
    const nextTimeLeft = { ...this.timeLeft };
    nextTimeLeft[player] += this.timeControl.incrementSeconds;

    const nextPawns = {
      1: player === 1 ? nextMyPawns : opPawns,
      2: player === 2 ? nextMyPawns : opPawns,
    };

    const moveInHistory: MoveInHistory = {
      index: this.moveCount,
      move: move,
      grid: nextGrid.clone(),
      catPos: [
        [nextPawns[1].cat.row, nextPawns[1].cat.col],
        [nextPawns[2].cat.row, nextPawns[2].cat.col],
      ],
      mousePos: [
        [nextPawns[1].mouse.row, nextPawns[1].mouse.col],
        [nextPawns[2].mouse.row, nextPawns[2].mouse.col],
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
          [opPawns.cat.row, opPawns.cat.col],
          [nextMyPawns.mouse.row, nextMyPawns.mouse.col]
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
    this.moveCount++;
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
          cat: new Cell(last.catPos[0][0], last.catPos[0][1]),
          mouse: new Cell(last.mousePos[0][0], last.mousePos[0][1]),
        },
        2: {
          cat: new Cell(last.catPos[1][0], last.catPos[1][1]),
          mouse: new Cell(last.mousePos[1][0], last.mousePos[1][1]),
        },
      };
      prevTimeLeft = {
        1: last.timeLeftSeconds[0],
        2: last.timeLeftSeconds[1],
      };
      this.moveCount = last.index + 1;
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
      this.moveCount = 1;
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
      { id: "p1-cat", playerId: 1, type: "cat", cell: this.pawns[1].cat },
      { id: "p1-mouse", playerId: 1, type: "mouse", cell: this.pawns[1].mouse },
      { id: "p2-cat", playerId: 2, type: "cat", cell: this.pawns[2].cat },
      { id: "p2-mouse", playerId: 2, type: "mouse", cell: this.pawns[2].mouse },
    ];
  }

  getWalls(): PlayerWall[] {
    const walls: PlayerWall[] = [];
    for (let r = 0; r < this.grid.height; r++) {
      for (let c = 0; c < this.grid.width; c++) {
        const val = this.grid.cells[r][c];
        if (val & 1) {
          const owner = this.grid.verticalOwners[r][c] as PlayerId | 0;
          walls.push({
            wall: new Wall(new Cell(r, c), "vertical"),
            playerId: owner !== 0 ? owner : undefined,
            state: "placed",
          });
        }
        if (val & 2) {
          const owner = this.grid.horizontalOwners[r][c] as PlayerId | 0;
          walls.push({
            wall: new Wall(new Cell(r, c), "horizontal"),
            playerId: owner !== 0 ? owner : undefined,
            state: "placed",
          });
        }
      }
    }
    return walls;
  }
}
