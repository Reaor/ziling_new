/**
 * Grid — discrete 2D cell manager for character positioning and MAPF collision avoidance.
 * @class
 */
export class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Int32Array(cols * rows);
    this.cells.fill(-1);
    this.occupiedKeys = new Set();
    this.reservations = new Map();
  }

  occupy(charId, col, row) {
    if (!this.isInBounds(col, row)) return false;
    const idx = col + row * this.cols;
    if (this.cells[idx] !== -1) return false;
    this.cells[idx] = charId;
    this.occupiedKeys.add(this.getCellKey(col, row));
    return true;
  }

  vacate(col, row) {
    if (!this.isInBounds(col, row)) return;
    const idx = col + row * this.cols;
    if (this.cells[idx] === -1) return;
    this.cells[idx] = -1;
    this.occupiedKeys.delete(this.getCellKey(col, row));
  }

  isOccupied(col, row) {
    if (!this.isInBounds(col, row)) return false;
    return this.cells[col + row * this.cols] !== -1;
  }

  isInBounds(col, row) {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  isReserved(col, row, timeSlot) {
    const inner = this.reservations.get(timeSlot);
    if (!inner) return false;
    return inner.has(this.getCellKey(col, row));
  }

  reserve(charId, col, row, timeSlot) {
    if (!this.isInBounds(col, row)) return;
    let inner = this.reservations.get(timeSlot);
    if (!inner) {
      inner = new Map();
      this.reservations.set(timeSlot, inner);
    }
    inner.set(this.getCellKey(col, row), charId);
  }

  clearReservations(timeSlot) {
    if (timeSlot === undefined) {
      this.reservations.clear();
    } else {
      this.reservations.delete(timeSlot);
    }
  }

  getCellKey(col, row) {
    return row * 10000 + col;
  }

  getCharId(col, row) {
    return this.cells[col + row * this.cols];
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Int32Array(cols * rows);
    this.cells.fill(-1);
    this.occupiedKeys.clear();
    this.reservations.clear();
  }

  clearAll() {
    this.cells.fill(-1);
    this.occupiedKeys.clear();
    this.reservations.clear();
  }
}
