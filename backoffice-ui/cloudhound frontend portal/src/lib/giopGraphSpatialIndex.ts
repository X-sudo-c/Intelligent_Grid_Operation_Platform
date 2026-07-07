/**
 * Uniform grid spatial index for fast viewport-based node queries.
 *
 * Instead of testing every node against the viewport each frame, we bin nodes
 * into grid cells and only test nodes in cells that overlap the viewport.
 *
 * For 3000 nodes, this reduces viewport-cull checks from 3000 → ~300 per frame.
 */

export interface SpatialQuery {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface SpatialIndexEntry {
  id: string;
  x: number;
  y: number;
}

export interface SpatialIndexQueryResult<T extends SpatialIndexEntry> {
  /** Entries in cells that intersect the query rect. */
  visible: T[];
  /** Indices (in the original array) of visible entries. */
  visibleIndices: number[];
}

export class GiopSpatialIndex<T extends SpatialIndexEntry> {
  private cellSize: number;
  private cols = 0;
  private rows = 0;
  private originX = 0;
  private originY = 0;
  private cells: number[][] = [];
  private entries: T[] = [];

  constructor(cellSize = 300) {
    this.cellSize = cellSize;
  }

  /** Rebuild the index from a new set of entries. Call when graph data changes. */
  build(entries: T[]): void {
    this.entries = entries;
    if (entries.length === 0) {
      this.cells = [];
      this.cols = 0;
      this.rows = 0;
      return;
    }

    // Compute bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.x < minX) minX = e.x;
      if (e.y < minY) minY = e.y;
      if (e.x > maxX) maxX = e.x;
      if (e.y > maxY) maxY = e.y;
    }

    // Pad bounds slightly
    const pad = this.cellSize;
    this.originX = minX - pad;
    this.originY = minY - pad;
    this.cols = Math.max(1, Math.ceil((maxX - minX + pad * 2) / this.cellSize));
    this.rows = Math.max(1, Math.ceil((maxY - minY + pad * 2) / this.cellSize));

    // Initialize cells
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = [];
    }

    // Bin entries
    for (let i = 0; i < entries.length; i++) {
      const col = Math.floor((entries[i].x - this.originX) / this.cellSize);
      const row = Math.floor((entries[i].y - this.originY) / this.cellSize);
      if (col >= 0 && col < this.cols && row >= 0 && row < this.rows) {
        this.cells[row * this.cols + col].push(i);
      } else {
        // Out of bounds — store in nearest edge cell
        const c = Math.max(0, Math.min(this.cols - 1, col));
        const r = Math.max(0, Math.min(this.rows - 1, row));
        this.cells[r * this.cols + c].push(i);
      }
    }
  }

  /** Query entries that fall within the given world-space rectangle. */
  query(rect: SpatialQuery): SpatialIndexQueryResult<T> {
    if (this.cells.length === 0 || this.entries.length === 0) {
      return { visible: [], visibleIndices: [] };
    }

    const colMin = Math.max(0, Math.floor((rect.xMin - this.originX) / this.cellSize));
    const colMax = Math.min(this.cols - 1, Math.floor((rect.xMax - this.originX) / this.cellSize));
    const rowMin = Math.max(0, Math.floor((rect.yMin - this.originY) / this.cellSize));
    const rowMax = Math.min(this.rows - 1, Math.floor((rect.yMax - this.originY) / this.cellSize));

    const seen = new Set<number>();
    const visible: T[] = [];
    const visibleIndices: number[] = [];

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        const cell = this.cells[row * this.cols + col];
        if (!cell) continue;
        for (let k = 0; k < cell.length; k++) {
          const idx = cell[k];
          if (seen.has(idx)) continue;
          seen.add(idx);
          const entry = this.entries[idx];
          if (
            entry.x >= rect.xMin && entry.x <= rect.xMax &&
            entry.y >= rect.yMin && entry.y <= rect.yMax
          ) {
            visible.push(entry);
            visibleIndices.push(idx);
          }
        }
      }
    }

    return { visible, visibleIndices };
  }

  /** Number of entries in the index. */
  get size(): number {
    return this.entries.length;
  }

  /** Number of cells in the grid. */
  get cellCount(): number {
    return this.cells.length;
  }
}
