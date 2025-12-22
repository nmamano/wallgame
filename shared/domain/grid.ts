import type { PlayerId, Cell, WallPosition, Variant } from "./game-types";
import { cellEq } from "./game-utils";

/**
 * Represents the state of a 2D grid-based board including wall positions and ownership.
 *
 * Main responsibilities:
 * - Track wall placement and ownership on the grid for both orientations.
 * - Validate actions such as building a wall, including boundary and rule checks.
 * - Compute pathfinding and reachability for game logic (distance, accessible neighbors, etc).
 */
export class Grid {
  /**
   * Single grid storing wall status and ownership for each cell.
   *
   * Encoding per cell (32-bit integer):
   * - Lower byte (bits 0-7): Vertical wall status and owner
   *   - 0: No vertical wall
   *   - Values > 0 indicate a vertical wall exists, with the value being the owner's PlayerId
   *
   * - Next byte (bits 8-15): Horizontal wall status and owner
   *   - 0: No horizontal wall
   *   - Values > 0 indicate a horizontal wall exists, with the value being the owner's PlayerId
   */
  private cells: number[][];

  constructor(
    public width: number,
    public height: number,
    public variant: Variant = "standard",
  ) {
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => 0),
    );
  }

  private verticalWallOwner(cellValue: number): number {
    return cellValue & 0xff;
  }

  private horizontalWallOwner(cellValue: number): number {
    return (cellValue >> 8) & 0xff;
  }

  inBounds(cell: Cell): boolean {
    const [r, c] = cell;
    return r >= 0 && r < this.height && c >= 0 && c < this.width;
  }

  canBuildWall(
    cats: [Cell, Cell],
    mice: [Cell, Cell],
    wall: WallPosition,
  ): boolean {
    // Check if wall is out of bounds
    if (!this.inBounds(wall.cell)) {
      return false;
    }

    const r = wall.cell[0];
    const c = wall.cell[1];

    // Check if wall placement would extend beyond board boundaries
    // Vertical walls are placed to the right of a cell, so can't be placed at rightmost column
    if (wall.orientation === "vertical" && c >= this.width - 1) {
      return false;
    }
    // Horizontal walls are placed above a cell, so can't be placed at topmost row (row 0)
    if (wall.orientation === "horizontal" && r <= 0) {
      return false;
    }

    const current = this.cells[r][c];

    // Check if wall already exists
    if (
      wall.orientation === "vertical" &&
      this.verticalWallOwner(current) !== 0
    )
      return false;
    if (
      wall.orientation === "horizontal" &&
      this.horizontalWallOwner(current) !== 0
    )
      return false;

    // Temporarily add wall (with owner = 1, which doesn't matter for path calculation)
    // to check for reachability
    const testValue =
      wall.orientation === "vertical"
        ? (current & 0xff00) | 1
        : (current & 0xff) | (1 << 8);
    this.cells[r][c] = testValue;
    const res = this.isValidBoard(cats, mice);
    this.cells[r][c] = current;
    return res;
  }

  addWall(wall: WallPosition) {
    const r = wall.cell[0];
    const c = wall.cell[1];
    const current = this.cells[r][c];
    const ownerId = wall.playerId ?? 1; // Default to player 1 if not specified

    if (wall.orientation === "vertical") {
      // Set lower byte to owner ID, preserve upper byte
      this.cells[r][c] = (current & 0xff00) | ownerId;
    } else {
      // Set upper byte to owner ID, preserve lower byte
      this.cells[r][c] = (current & 0xff) | (ownerId << 8);
    }
  }

  private isValidBoard(cats: [Cell, Cell], mice: [Cell, Cell]): boolean {
    for (let k = 0; k < cats.length; k++) {
      if (!this.canReach(cats[k], mice[k])) return false;
    }
    return true;
  }

  private canReach(start: Cell, target: Cell): boolean {
    return this.distance(start, target) !== -1;
  }

  public distance(start: Cell, target: Cell): number {
    if (cellEq(start, target)) return 0;
    const C = this.width;
    const posToKey = (pos: Cell): number => pos[0] * C + pos[1];

    const queue: Cell[] = [];
    let i = 0;
    queue.push(start);
    const dist = new Map<number, number>();
    dist.set(posToKey(start), 0);

    while (i < queue.length) {
      const pos = queue[i];
      i++;
      const nbrs = this.accessibleNeighbors(pos);
      for (const nbr of nbrs) {
        const key = posToKey(nbr);
        if (!dist.has(key)) {
          dist.set(key, dist.get(posToKey(pos))! + 1);
          if (cellEq(nbr, target)) return dist.get(key)!;
          queue.push(nbr);
        }
      }
    }
    return -1;
  }

  hasWall(wall: WallPosition): boolean {
    const [r, c] = wall.cell;
    if (!this.inBounds([r, c])) return false;
    const val = this.cells[r][c];
    if (wall.orientation === "vertical") {
      return this.verticalWallOwner(val) !== 0;
    } else {
      return this.horizontalWallOwner(val) !== 0;
    }
  }

  accessibleNeighbors(pos: Cell): Cell[] {
    const [r, c] = pos;
    const res: Cell[] = [];

    // Right: check wall to the right (bit 1) of current cell
    if (
      c + 1 < this.width &&
      !this.hasWall({ cell: [r, c], orientation: "vertical" })
    )
      res.push([r, c + 1]);

    // Left: check wall to the right (bit 1) of left neighbor
    if (
      c - 1 >= 0 &&
      !this.hasWall({ cell: [r, c - 1], orientation: "vertical" })
    )
      res.push([r, c - 1]);

    // Down: check wall above (bit 2) bottom neighbor
    if (
      r + 1 < this.height &&
      !this.hasWall({ cell: [r + 1, c], orientation: "horizontal" })
    )
      res.push([r + 1, c]);

    // Up: check wall above (bit 2) current cell
    if (
      r - 1 >= 0 &&
      !this.hasWall({ cell: [r, c], orientation: "horizontal" })
    )
      res.push([r - 1, c]);

    return res;
  }

  getWalls(): WallPosition[] {
    const walls: WallPosition[] = [];
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const val = this.cells[r][c];
        const verticalOwner = this.verticalWallOwner(val);
        const horizontalOwner = this.horizontalWallOwner(val);

        if (verticalOwner !== 0) {
          walls.push({
            cell: [r, c],
            orientation: "vertical",
            playerId: verticalOwner as PlayerId,
          });
        }
        if (horizontalOwner !== 0) {
          walls.push({
            cell: [r, c],
            orientation: "horizontal",
            playerId: horizontalOwner as PlayerId,
          });
        }
      }
    }
    return walls;
  }

  clone(): Grid {
    const newGrid = new Grid(this.width, this.height, this.variant);
    newGrid.cells = this.cells.map((row) => [...row]);
    return newGrid;
  }
}
