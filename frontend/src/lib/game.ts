import { type PlayerColor } from "./player-colors";

export class Cell {
  constructor(public row: number, public col: number) {}

  toNotation(totalRows: number = 10): string {
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

export class Wall {
  constructor(
    public cell: Cell,
    public orientation: WallOrientation,
    public state: "placed" | "staged" | "premoved" | "calculated" | "missing" = "placed",
    public playerColor?: PlayerColor
  ) {}

  toNotation(totalRows: number = 10): string {
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

export function createCell(notation: string, totalRows: number = 10): Cell {
  const colChar = notation.charAt(0).toLowerCase();
  const rowStr = notation.slice(1);
  
  const col = colChar.charCodeAt(0) - 'a'.charCodeAt(0);
  const rowNum = parseInt(rowStr, 10);
  
  // Convert 1-based bottom-up row to 0-based top-down row
  const row = totalRows - rowNum;
  
  return new Cell(row, col);
}

export function createWall(notation: string, totalRows: number = 10, color?: PlayerColor): Wall {
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

  return new Wall(cell, orientation, "placed", color);
}
