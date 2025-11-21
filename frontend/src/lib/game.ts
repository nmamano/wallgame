
export type PlayerId = 1 | 2;

export class Cell {
  constructor(public row: number, public col: number) {}

  toNotation(totalRows: number): string {
    const colChar = String.fromCharCode('a'.charCodeAt(0) + this.col);
    const rowNum = totalRows - this.row;
    return `${colChar}${rowNum}`;
  }

  toKey(): string {
    return `${this.row}-${this.col}`;
  }

  equals(other: Cell): boolean {
    return this.row === other.row && this.col === other.col;
  }
}

export type WallOrientation = 'vertical' | 'horizontal';

export type WallState =
  | "placed"
  | "staged"
  | "premoved"
  | "calculated"
  | "missing";

export class Wall {
  // Vertical: wall to the right of the cell (between col and col+1)
  // Horizontal: wall above the cell (between row and row-1)
  constructor(
    public cell: Cell,
    public orientation: WallOrientation
  ) {}

  toNotation(totalRows: number): string {
    const symbol = this.orientation === 'vertical' ? '>' : '^';
    return `${symbol}${this.cell.toNotation(totalRows)}`;
  }

  // Returns coordinates compatible with the Board component
  // row1, col1, row2, col2
  toCoordinates(): { row1: number; col1: number; row2: number; col2: number } {
    if (this.orientation === 'vertical') {
      // >e4 means wall to the right of e4 (between e4 and f4)
      // Between (row, col) and (row, col+1)
      return {
        row1: this.cell.row,
        col1: this.cell.col,
        row2: this.cell.row,
        col2: this.cell.col + 1
      };
    } else {
      // ^e4 means wall above e4 (between e4 and e5)
      // In top-down, e5 is row-1, e4 is row
      // So between (row-1, col) and (row, col)
      return {
        row1: this.cell.row - 1,
        col1: this.cell.col,
        row2: this.cell.row,
        col2: this.cell.col
      };
    }
  }

  get row1(): number { return this.toCoordinates().row1; }
  get col1(): number { return this.toCoordinates().col1; }
  get row2(): number { return this.toCoordinates().row2; }
  get col2(): number { return this.toCoordinates().col2; }
}

export interface PlayerWall {
  wall: Wall;
  playerId?: PlayerId;
  state: WallState;
}

export type PawnType = "cat" | "mouse";

export interface Pawn {
  id: string;
  playerId: PlayerId;
  type: PawnType;
  cell: Cell;
  pawnStyle?: string;
}

export function createCell(notation: string, totalRows: number): Cell {
  const colChar = notation.charAt(0).toLowerCase();
  const rowStr = notation.slice(1);
  
  const col = colChar.charCodeAt(0) - 'a'.charCodeAt(0);
  const rowNum = parseInt(rowStr, 10);
  
  // Convert 1-based bottom-up row to 0-based top-down row
  const row = totalRows - rowNum;
  
  return new Cell(row, col);
}

export function createWall(notation: string, totalRows: number): Wall {
  const symbol = notation.charAt(0);
  const cellNotation = notation.slice(1);
  const cell = createCell(cellNotation, totalRows);
  
  let orientation: WallOrientation;
  if (symbol === '>') {
    orientation = 'vertical';
  } else if (symbol === '^') {
    orientation = 'horizontal';
  } else {
    throw new Error(`Invalid wall notation symbol: ${symbol}`);
  }

  return new Wall(cell, orientation);
}

export function createPlayerWall(notation: string, totalRows: number, playerId: PlayerId, state: WallState = "placed"): PlayerWall {
  const wall = createWall(notation, totalRows);
  return {
    wall,
    playerId,
    state
  };
}

export type Pos = [number, number];

export function posEq(a: Pos, b: Pos): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export class Action {
  constructor(
    public type: 'cat' | 'mouse' | 'wall',
    public target: Cell,
    public wallOrientation?: WallOrientation
  ) {}

  static fromNotation(notation: string, totalRows: number): Action {
    const firstChar = notation.charAt(0);
    if (firstChar === 'C') {
      return new Action('cat', createCell(notation.slice(1), totalRows));
    } else if (firstChar === 'M') {
      return new Action('mouse', createCell(notation.slice(1), totalRows));
    } else if (firstChar === '>' || firstChar === '^') {
      const orientation = firstChar === '>' ? 'vertical' : 'horizontal';
      return new Action('wall', createCell(notation.slice(1), totalRows), orientation);
    }
    throw new Error(`Invalid action notation: ${notation}`);
  }

  toNotation(totalRows: number): string {
    if (this.type === 'cat') return `C${this.target.toNotation(totalRows)}`;
    if (this.type === 'mouse') return `M${this.target.toNotation(totalRows)}`;
    if (this.type === 'wall') {
      const symbol = this.wallOrientation === 'vertical' ? '>' : '^';
      return `${symbol}${this.target.toNotation(totalRows)}`;
    }
    return '';
  }
}

export class Move {
  constructor(public actions: Action[]) {}

  static fromNotation(notation: string, totalRows: number): Move {
    if (notation === '---') return new Move([]);
    const actionStrs = notation.split('.');
    const actions = actionStrs.map(s => Action.fromNotation(s, totalRows));
    return new Move(actions);
  }

  toNotation(totalRows: number): string {
    if (this.actions.length === 0) return '---';
    const sortedActions = [...this.actions].sort((a, b) => {
      const typeOrder = { 'cat': 1, 'mouse': 2, 'wall': 3 };
      const ta = typeOrder[a.type];
      const tb = typeOrder[b.type];
      if (ta !== tb) return ta - tb;
      if (a.type === 'wall' && b.type === 'wall') {
        if (a.wallOrientation !== b.wallOrientation) {
          return a.wallOrientation === 'vertical' ? -1 : 1;
        }
        if (a.target.col !== b.target.col) return a.target.col - b.target.col;
        return a.target.row - b.target.row;
      }
      return 0;
    });
    return sortedActions.map(a => a.toNotation(totalRows)).join('.');
  }
}

export class Turn {
  constructor(public move1: Move, public move2?: Move) {}

  static fromNotation(notation: string, totalRows: number): Turn {
    const parts = notation.trim().split(/\s+/);
    if (parts.length === 1) {
      return new Turn(Move.fromNotation(parts[0], totalRows));
    }
    if (parts.length !== 2) throw new Error(`Invalid turn notation: ${notation}`);
    return new Turn(Move.fromNotation(parts[0], totalRows), Move.fromNotation(parts[1], totalRows));
  }

  toNotation(totalRows: number): string {
    if (!this.move2) return this.move1.toNotation(totalRows);
    return `${this.move1.toNotation(totalRows)} ${this.move2.toNotation(totalRows)}`;
  }
}

export class TimeControl {
  constructor(public initialSeconds: number, public incrementSeconds: number) {}
  toString() { return `${this.initialSeconds}+${this.incrementSeconds}`; }
}

export class BoardDimensions {
  constructor(public width: number, public height: number) {}
}

export class Grid {
  // 0: no wall
  // 1: vertical wall (>) to the right of this cell
  // 2: horizontal wall (^) above this cell
  // 3: both
  public cells: number[][];
  
  // Tracks owner of walls. 
  // 0: None
  // 1: Player 1
  // 2: Player 2
  public verticalOwners: number[][];
  public horizontalOwners: number[][];
  
  public variant: string = "Standard";

  constructor(public width: number, public height: number) {
    this.cells = Array(height).fill(0).map(() => Array(width).fill(0));
    this.verticalOwners = Array(height).fill(0).map(() => Array(width).fill(0));
    this.horizontalOwners = Array(height).fill(0).map(() => Array(width).fill(0));
  }

  dimensions(): BoardDimensions {
    return new BoardDimensions(this.width, this.height);
  }

  inBounds(cell: Cell | Pos): boolean {
    const [r, c] = cell instanceof Cell ? [cell.row, cell.col] : cell;
    return r >= 0 && r < this.height && c >= 0 && c < this.width;
  }

  canBuildWall(
    cats: [Pos, Pos],
    mice: [Pos, Pos],
    wall: Wall
  ): boolean {
    const pos: Pos = [wall.cell.row, wall.cell.col];
    const current = this.cells[pos[0]][pos[1]];
    // 1 for vertical (>), 2 for horizontal (^)
    const wallBit = wall.orientation === 'vertical' ? 1 : 2;
    
    if ((current & wallBit) !== 0) return false;

    this.cells[pos[0]][pos[1]] = current | wallBit;
    const res = this.isValidBoard(cats, mice);
    this.cells[pos[0]][pos[1]] = current;
    return res;
  }
  
  addWall(wall: Wall, owner?: PlayerId) {
    const r = wall.cell.row;
    const c = wall.cell.col;
    if (wall.orientation === 'vertical') {
      this.cells[r][c] |= 1;
      if (owner) this.verticalOwners[r][c] = owner;
    } else {
      this.cells[r][c] |= 2;
      if (owner) this.horizontalOwners[r][c] = owner;
    }
  }

  private isValidBoard(cats: [Pos, Pos], mice: [Pos, Pos]): boolean {
    for (let k = 0; k < cats.length; k++) {
      if (!this.canReach(cats[k], mice[k])) return false;
    }
    return true;
  }

  private canReach(start: Pos, target: Pos): boolean {
    return this.distance(start, target) !== -1;
  }

  public distance(start: Pos, target: Pos): number {
    if (posEq(start, target)) return 0;
    const C = this.width;
    const posToKey = (pos: Pos): number => pos[0] * C + pos[1];

    const queue: Pos[] = [];
    let i = 0;
    queue.push(start);
    const dist: Map<number, number> = new Map();
    dist.set(posToKey(start), 0);
    
    while (i < queue.length) {
      const pos = queue[i];
      i++;
      const nbrs = this.accessibleNeighbors(pos);
      for (let k = 0; k < nbrs.length; k++) {
        let nbr = nbrs[k];
        const key = posToKey(nbr);
        if (!dist.has(key)) {
          dist.set(key, dist.get(posToKey(pos))! + 1);
          if (posEq(nbr, target)) return dist.get(key)!;
          queue.push(nbr);
        }
      }
    }
    return -1;
  }

  hasWall(cell: Cell | Pos, orientation: WallOrientation): boolean {
    const [r, c] = cell instanceof Cell ? [cell.row, cell.col] : cell;
    if (!this.inBounds([r, c])) return false;
    const val = this.cells[r][c];
    const bit = orientation === 'vertical' ? 1 : 2;
    return (val & bit) !== 0;
  }

  accessibleNeighbors(pos: Pos): Pos[] {
    const [r, c] = pos;
    const res: Pos[] = [];
    
    // Right: check wall to the right (bit 1) of current cell
    if (c + 1 < this.width && !this.hasWall([r, c], 'vertical')) res.push([r, c + 1]);
    
    // Left: check wall to the right (bit 1) of left neighbor
    if (c - 1 >= 0 && !this.hasWall([r, c - 1], 'vertical')) res.push([r, c - 1]);
    
    // Down: check wall above (bit 2) bottom neighbor
    if (r + 1 < this.height && !this.hasWall([r + 1, c], 'horizontal')) res.push([r + 1, c]);
    
    // Up: check wall above (bit 2) current cell
    if (r - 1 >= 0 && !this.hasWall([r, c], 'horizontal')) res.push([r - 1, c]);
    
    return res;
  }
  clone(): Grid {
    const newGrid = new Grid(this.width, this.height);
    newGrid.cells = this.cells.map(row => [...row]);
    newGrid.verticalOwners = this.verticalOwners.map(row => [...row]);
    newGrid.horizontalOwners = this.horizontalOwners.map(row => [...row]);
    newGrid.variant = this.variant;
    return newGrid;
  }
}

export type BoardSettings = {
  variant: string;
  dimensions: BoardDimensions;
  startPos: {
    p1Cat: Pos;
    p1Mouse: Pos;
    p2Cat: Pos;
    p2Mouse: Pos;
  };
  startingWalls: Grid;
};

export type MoveInHistory = {
  index: number;
  move: Move;
  grid: Grid;
  catPos: [Pos, Pos];
  mousePos: [Pos, Pos];
  timeLeftSeconds: [number, number];
  distances: [number, number];
  wallCounts: [number, number];
};

export type TurnInHistory = {
  move1: MoveInHistory;
  move2?: MoveInHistory;
};

export type TurnHistory = TurnInHistory[];

export async function getAiMove(
  grid: Grid,
  aiCatPos: Pos,
  opponentMousePos: Pos
): Promise<Move> {
  return DoubleWalkMove(grid, aiCatPos, opponentMousePos);
}

// Simple AI that walks towards the goal. It does not build any walls.
function DoubleWalkMove(grid: Grid, aiPos: Pos, aiGoal: Pos): Move {
  const curDist = grid.distance(aiPos, aiGoal);
  const dist2offsets = [
    [0, 2],
    [1, 1],
    [2, 0],
    [1, -1],
    [0, -2],
    [-1, -1],
    [-2, 0],
    [-1, 1],
  ];
  for (let k = 0; k < 8; k++) {
    const [or, oc] = [dist2offsets[k][0], dist2offsets[k][1]];
    const candidatePos: Pos = [aiPos[0] + or, aiPos[1] + oc];
    if (
      grid.inBounds(candidatePos) &&
      grid.distance(aiPos, candidatePos) === 2 &&
      grid.distance(candidatePos, aiGoal) === curDist - 2
    ) {
      return new Move([new Action('cat', new Cell(candidatePos[0], candidatePos[1]))]);
    }
  }
  // If there is no cell at distance 2 which is 2 steps closer to the goal,
  // it means that the AI is at distance 1 from its goal. In this case, we simply
  // move to the goal.
  return new Move([new Action('cat', new Cell(aiGoal[0], aiGoal[1]))]);
}

