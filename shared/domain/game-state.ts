import { isClassicVariant } from "./game-types";
import type {
  PlayerId,
  GameStatus,
  GameResult,
  Cell,
  WallPosition,
  Move,
  TimeControlConfig,
  GameConfiguration,
  GamePawnType,
  Pawn,
  GameAction,
  GameInitialState,
  StandardInitialState,
  ClassicInitialState,
  SurvivalInitialState,
  GamePawns,
} from "./game-types";
import { Grid } from "./grid";
import { cellEq, endedBeforeBothPlayersMoved } from "./game-utils";
import {
  boardPawns,
  clonePawns,
  hasPawn,
  pawnCell,
  pawnFamilyForVariant,
  requirePawnCell,
  withPawnCell,
} from "./pawns";

// Type guards for variant-specific initial states
export function isStandardInitialState(
  state: GameInitialState,
): state is StandardInitialState {
  return (
    "pawns" in state && "mouse" in (state as StandardInitialState).pawns.p1
  );
}

export function isClassicInitialState(
  state: GameInitialState,
): state is ClassicInitialState {
  return "pawns" in state && "home" in (state as ClassicInitialState).pawns.p1;
}

export function isSurvivalInitialState(
  state: GameInitialState,
): state is SurvivalInitialState {
  return "turnsToSurvive" in state;
}

export interface MoveInHistory {
  index: number;
  move: Move;
  grid: Grid;
  /** Snapshot of every pawn after this move. Deep-copied, never shared. */
  pawns: GamePawns;
  timeLeftSeconds: [number, number];
  distances: [number, number];
  wallCounts: [number, number];
}

export class GameState {
  grid: Grid;
  pawns: GamePawns;
  turn: PlayerId;
  moveCount: number; // Completed moves count (0 before any moves)
  actionsRemaining: 1 | 2;
  previousPawnPosition?: { type: GamePawnType; cell: Cell };

  history: MoveInHistory[];
  status: GameStatus;
  result?: GameResult;

  timeControl: TimeControlConfig;
  timeLeft: Record<PlayerId, number>; // Seconds with 0.1s resolution
  lastMoveTime: number;

  config: GameConfiguration;

  // Initial state for undoing the first move
  private initialGrid: Grid;
  private initialPawns: GamePawns;
  private initialTurn: PlayerId;
  private initialActionsRemaining: 1 | 2;
  private initialPreviousPawnPosition?: { type: GamePawnType; cell: Cell };

  constructor(config: GameConfiguration, startTime: number) {
    this.config = config;
    this.grid = new Grid(config.boardWidth, config.boardHeight, config.variant);

    const variantConfig = config.variantConfig;

    // Every pawn below is one the variant actually has. There is no slot to
    // fill for a pawn a variant lacks, so nothing has to be invented.
    const family = pawnFamilyForVariant(config.variant);
    if (family === "survival") {
      if (!isSurvivalInitialState(variantConfig)) {
        throw new Error("Survival game requires a survival initial state");
      }
      this.pawns = {
        kind: "survival",
        cat: [variantConfig.cat[0], variantConfig.cat[1]],
        mouse: [variantConfig.mouse[0], variantConfig.mouse[1]],
      };
    } else if (family === "classic") {
      if (!isClassicInitialState(variantConfig)) {
        throw new Error("Classic game requires a classic initial state");
      }
      this.pawns = {
        kind: "classic",
        pawns: {
          1: {
            cat: [variantConfig.pawns.p1.cat[0], variantConfig.pawns.p1.cat[1]],
            home: [
              variantConfig.pawns.p1.home[0],
              variantConfig.pawns.p1.home[1],
            ],
          },
          2: {
            cat: [variantConfig.pawns.p2.cat[0], variantConfig.pawns.p2.cat[1]],
            home: [
              variantConfig.pawns.p2.home[0],
              variantConfig.pawns.p2.home[1],
            ],
          },
        },
      };
    } else {
      if (!isStandardInitialState(variantConfig)) {
        throw new Error("Standard game requires a standard initial state");
      }
      this.pawns = {
        kind: "standard",
        pawns: {
          1: {
            cat: [variantConfig.pawns.p1.cat[0], variantConfig.pawns.p1.cat[1]],
            mouse: [
              variantConfig.pawns.p1.mouse[0],
              variantConfig.pawns.p1.mouse[1],
            ],
          },
          2: {
            cat: [variantConfig.pawns.p2.cat[0], variantConfig.pawns.p2.cat[1]],
            mouse: [
              variantConfig.pawns.p2.mouse[0],
              variantConfig.pawns.p2.mouse[1],
            ],
          },
        },
      };
    }

    // Add initial walls
    variantConfig.walls.forEach((wall) => {
      this.grid.addWall(wall);
    });

    // Save initial state
    this.initialGrid = this.grid.clone();
    this.initialPawns = clonePawns(this.pawns);

    const setupTurn = "turn" in variantConfig ? variantConfig.turn : null;
    const [spentAction] = setupTurn?.actionsTaken ?? [];
    this.turn = setupTurn?.playerId ?? 1;
    this.actionsRemaining = spentAction ? 1 : 2;
    this.previousPawnPosition =
      spentAction?.type === "cat" || spentAction?.type === "mouse"
        ? { type: spentAction.type, cell: spentAction.source }
        : undefined;
    this.initialTurn = this.turn;
    this.initialActionsRemaining = this.actionsRemaining;
    this.initialPreviousPawnPosition = this.previousPawnPosition
      ? {
          type: this.previousPawnPosition.type,
          cell: [...this.previousPawnPosition.cell] as Cell,
        }
      : undefined;
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

  private isPawnActive(playerId: PlayerId, pawnType: GamePawnType): boolean {
    return hasPawn(this.pawns, playerId, pawnType);
  }

  /** Returns the target cell for a player's cat based on game variant.
   *  - Classic: own home
   *  - Survival: the mouse (player 2's)
   *  - Standard/Freestyle: opponent's mouse
   *
   * Optionally accepts pawns to use instead of this.pawns (e.g. for
   * mid-move wall legality checks where pawn positions are pending).
   */
  goalCell(playerId: PlayerId, pawns?: GamePawns): Cell {
    const p = pawns ?? this.pawns;
    if (isClassicVariant(this.config.variant)) {
      return requirePawnCell(p, playerId, "home");
    }
    if (this.config.variant === "survival") {
      return requirePawnCell(p, 2, "mouse");
    }
    const opponent: PlayerId = playerId === 1 ? 2 : 1;
    return requirePawnCell(p, opponent, "mouse");
  }

  clone(): GameState {
    const newGame = new GameState(this.config, this.lastMoveTime);
    newGame.grid = this.grid.clone();
    newGame.pawns = clonePawns(this.pawns);
    newGame.turn = this.turn;
    newGame.actionsRemaining = this.actionsRemaining;
    newGame.previousPawnPosition = this.previousPawnPosition
      ? {
          type: this.previousPawnPosition.type,
          cell: [...this.previousPawnPosition.cell] as Cell,
        }
      : undefined;
    newGame.moveCount = this.moveCount;
    newGame.history = [...this.history];
    newGame.status = this.status;
    newGame.result = this.result ? { ...this.result } : undefined;
    newGame.timeLeft = { ...this.timeLeft };
    newGame.initialGrid = this.initialGrid.clone();
    newGame.initialPawns = clonePawns(this.initialPawns);
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

    // Nobody wins a game that ended before both players had a turn. Quitting
    // that early aborts the game instead: no winner, and downstream consumers
    // skip it for ratings, records, match score and past games.
    const isAbort = endedBeforeBothPlayersMoved(this.moveCount);

    switch (action.kind) {
      case "move":
        this.applyMove(action.move, action.timestamp);
        break;
      case "resign":
        this.status = "finished";
        this.result = isAbort
          ? { reason: "aborted" }
          : {
              winner: action.playerId === 1 ? 2 : 1,
              reason: "resignation",
            };
        break;
      case "timeout":
        this.status = "finished";
        this.result = isAbort
          ? { reason: "aborted" }
          : {
              winner: action.playerId === 1 ? 2 : 1,
              reason: "timeout",
            };
        break;
      case "draw":
        this.status = "finished";
        this.result = isAbort
          ? { reason: "aborted" }
          : {
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
    if (move.actions.length > this.actionsRemaining) {
      throw new Error(
        `Only ${this.actionsRemaining} action${this.actionsRemaining === 1 ? "" : "s"} remain in this turn`,
      );
    }

    const player = this.turn;
    const opponent: PlayerId = player === 1 ? 2 : 1;

    const nextGrid = this.grid.clone();
    // Working copy of every pawn. Only the mover's pawns change, but carrying
    // the whole shape means wall legality and the win checks below read one
    // consistent state instead of reassembling it from halves.
    let nextPawns = clonePawns(this.pawns);

    const isClassic = isClassicVariant(this.config.variant);
    let actionsUsed = 0;

    for (const action of move.actions) {
      if (
        this.previousPawnPosition &&
        action.type === this.previousPawnPosition.type &&
        cellEq(action.target, this.previousPawnPosition.cell)
      ) {
        throw new Error(
          "A pawn cannot immediately return to its previous cell",
        );
      }
      if (action.type === "cat" || action.type === "mouse") {
        if (!this.isPawnActive(player, action.type)) {
          throw new Error("Pawn not available for this player");
        }
        if (action.type === "mouse") {
          if (isClassic) {
            throw new Error("Mouse cannot move in classic variant");
          }
          if (
            this.config.variant === "survival" &&
            !(this.config.variantConfig as SurvivalInitialState).mouseCanMove
          ) {
            throw new Error("Mouse cannot move in survival variant");
          }
        }
        const currentPos = requirePawnCell(nextPawns, player, action.type);
        const targetPos = action.target;

        const dist =
          Math.abs(currentPos[0] - targetPos[0]) +
          Math.abs(currentPos[1] - targetPos[1]);
        actionsUsed += dist;
        if (actionsUsed > this.actionsRemaining) {
          throw new Error(
            `Only ${this.actionsRemaining} action${this.actionsRemaining === 1 ? "" : "s"} remain in this turn`,
          );
        }

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

        nextPawns = withPawnCell(nextPawns, player, action.type, targetPos);
      } else if (action.type === "wall") {
        actionsUsed += 1;
        if (actionsUsed > this.actionsRemaining) {
          throw new Error(
            `Only ${this.actionsRemaining} action${this.actionsRemaining === 1 ? "" : "s"} remain in this turn`,
          );
        }
        const wall: WallPosition = {
          cell: action.target,
          orientation: action.wallOrientation!,
        };

        const wallWithPlayer: WallPosition = {
          ...wall,
          playerId: player,
        };

        const p1Cat = requirePawnCell(nextPawns, 1, "cat");
        // Survival has no player 2 cat. canBuildWall takes a pair, so the one
        // cat on the board is checked twice rather than a second one invented.
        const p2Cat = pawnCell(nextPawns, 2, "cat") ?? p1Cat;
        const cats: [Cell, Cell] = [
          [p1Cat[0], p1Cat[1]],
          [p2Cat[0], p2Cat[1]],
        ];
        // Wall legality: each cat must keep a path to its goal.
        const mice: [Cell, Cell] = [
          this.goalCell(1, nextPawns),
          this.goalCell(2, nextPawns),
        ];

        if (!nextGrid.canBuildWall(cats, mice, wall)) {
          throw new Error("Illegal wall placement");
        }

        nextGrid.addWall(wallWithPlayer);
      }
    }

    // Win condition depends on variant:
    // - Standard/Freestyle: cat captures opponent's mouse
    // - Classic: cat reaches its own home
    const usesClassicRules = isClassicVariant(this.config.variant);
    let myCatCaught: boolean;
    let opCatCaught: boolean;

    if (usesClassicRules) {
      // Classic: cat reaches its own home
      myCatCaught = cellEq(
        requirePawnCell(nextPawns, player, "cat"),
        requirePawnCell(nextPawns, player, "home"),
      );
      opCatCaught = cellEq(
        requirePawnCell(nextPawns, opponent, "cat"),
        requirePawnCell(nextPawns, opponent, "home"),
      );
    } else {
      // Standard/Freestyle/Survival: cat captures opponent's mouse. A missing
      // cell means the variant has no such pawn, so no capture is possible.
      const myCat = pawnCell(nextPawns, player, "cat");
      const myMouse = pawnCell(nextPawns, player, "mouse");
      const opCat = pawnCell(nextPawns, opponent, "cat");
      const opMouse = pawnCell(nextPawns, opponent, "mouse");
      myCatCaught = !!myCat && !!opMouse && cellEq(myCat, opMouse);
      opCatCaught = !!opCat && !!myMouse && cellEq(opCat, myMouse);
    }

    // Update timeLeft with increment
    const nextTimeLeft = { ...this.timeLeft };
    nextTimeLeft[player] += this.timeControl.incrementSeconds;

    const nextMoveIndex = this.moveCount + 1;
    const moveInHistory: MoveInHistory = {
      index: nextMoveIndex,
      move: move,
      grid: nextGrid.clone(),
      // Deep copy: the snapshot must not share cells with the live state.
      pawns: clonePawns(nextPawns),
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
      // One-move-rule: if P1 reaches their goal first, P2 gets a draw
      // when they're within 2 steps of their own goal (not applicable to survival)
      if (
        player === 1 &&
        this.config.variant !== "survival" &&
        this.isPawnActive(opponent, "cat") &&
        this.isPawnActive(player, "mouse")
      ) {
        const opCatCell = requirePawnCell(this.pawns, opponent, "cat");
        const dist = this.grid.distance(
          [opCatCell[0], opCatCell[1]],
          this.goalCell(opponent),
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

    if (this.config.variant === "survival" && player === 1) {
      const turnsToSurvive = (this.config.variantConfig as SurvivalInitialState)
        .turnsToSurvive;
      if (!Number.isInteger(turnsToSurvive) || turnsToSurvive < 1) {
        throw new Error("Survival turns must be a positive integer.");
      }
      const catMoves = Math.ceil(nextMoveIndex / 2);
      if (catMoves >= turnsToSurvive) {
        this.status = "finished";
        this.result = {
          winner: 2,
          reason: "survival",
        };
        return;
      }
    }

    this.turn = opponent;
    this.actionsRemaining = 2;
    this.previousPawnPosition = undefined;
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
    let prevPawns: GamePawns;
    let prevTimeLeft: Record<PlayerId, number>;

    if (this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      prevGrid = last.grid;
      // Copy out, so replaying forward from here cannot mutate the snapshot.
      prevPawns = clonePawns(last.pawns);
      prevTimeLeft = {
        1: last.timeLeftSeconds[0],
        2: last.timeLeftSeconds[1],
      };
      this.moveCount = last.index;
      this.actionsRemaining = 2;
      this.previousPawnPosition = undefined;
    } else {
      prevGrid = this.initialGrid.clone();
      prevPawns = clonePawns(this.initialPawns);
      prevTimeLeft = {
        1: this.config.timeControl.initialSeconds,
        2: this.config.timeControl.initialSeconds,
      };
      this.moveCount = 0;
      this.turn = this.initialTurn;
      this.actionsRemaining = this.initialActionsRemaining;
      this.previousPawnPosition = this.initialPreviousPawnPosition
        ? {
            type: this.initialPreviousPawnPosition.type,
            cell: [...this.initialPreviousPawnPosition.cell] as Cell,
          }
        : undefined;
    }

    this.grid = prevGrid;
    this.pawns = prevPawns;
    this.timeLeft = prevTimeLeft;

    if (this.history.length > 0) {
      this.turn = this.turn === 1 ? 2 : 1;
    }
    this.status = "playing";
    this.result = undefined;
  }

  /**
   * Everything the board draws. In classic this includes each player's home,
   * typed "home" rather than masquerading as a mouse, so callers render it
   * directly instead of remapping it.
   */
  getPawns(): Pawn[] {
    return boardPawns(this.pawns);
  }

  getInitialSnapshot(): { grid: Grid; pawns: GamePawns } {
    return {
      grid: this.initialGrid.clone(),
      pawns: clonePawns(this.initialPawns),
    };
  }

  getInitialState(): GameInitialState {
    // Return the original variant config which contains the correct structure
    return this.config.variantConfig;
  }
}
