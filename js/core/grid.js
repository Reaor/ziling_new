/**
 * Grid — discrete 2D cell manager for character positioning and MAPF collision avoidance.
 *
 * Each cell is either empty (-1) or holds a character ID (>= 0). The grid supports
 * occupancy tracking, time-slot reservations (for path planning), and fast bounds checks.
 * Cell keys use a packed integer encoding (row * 10000 + col) for use as Map keys.
 *
 * @class
 */
export class Grid {
  /**
   * @param {number} cols — number of columns
   * @param {number} rows — number of rows
   */
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Int32Array(cols * rows);
    this.cells.fill(-1);
    this.occupiedKeys = new Set();
    this.reservations = new Map();
  }

  /**
   * Place a character on a cell.
   * @param {number} charId — non-negative character ID
   * @param {number} col
   * @param {number} row
   * @returns {boolean} true on success, false if out of bounds
   */
  occupy(charId, col, row) {
    if (!this.isInBounds(col, row)) return false;
    const idx = col + row * this.cols;
    if (this.cells[idx] !== -1) return false;
    this.cells[idx] = charId;
    this.occupiedKeys.add(this.getCellKey(col, row));
    return true;
  }

  /**
   * Remove a character from a cell. Safe no-op if out of bounds or already empty.
   * @param {number} col
   * @param {number} row
   */
  vacate(col, row) {
    if (!this.isInBounds(col, row)) return;
    const idx = col + row * this.cols;
    if (this.cells[idx] === -1) return;
    this.cells[idx] = -1;
    this.occupiedKeys.delete(this.getCellKey(col, row));
  }

  /**
   * Check if a cell currently holds a character.
   * @param {number} col
   * @param {number} row
   * @returns {boolean}
   */
  isOccupied(col, row) {
    if (!this.isInBounds(col, row)) return false;
    return this.cells[col + row * this.cols] !== -1;
  }

  /**
   * Bounds check.
   * @param {number} col
   * @param {number} row
   * @returns {boolean}
   */
  isInBounds(col, row) {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  /**
   * Check if a cell is reserved at a given future time slot.
   * @param {number} col
   * @param {number} row
   * @param {number} timeSlot
   * @returns {boolean}
   */
  isReserved(col, row, timeSlot) {
    const inner = this.reservations.get(timeSlot);
    if (!inner) return false;
    return inner.has(this.getCellKey(col, row));
  }

  /**
   * Reserve a cell for a character at a future time slot.
   * @param {number} charId
   * @param {number} col
   * @param {number} row
   * @param {number} timeSlot
   */
  reserve(charId, col, row, timeSlot) {
    if (!this.isInBounds(col, row)) return;
    let inner = this.reservations.get(timeSlot);
    if (!inner) {
      inner = new Map();
      this.reservations.set(timeSlot, inner);
    }
    inner.set(this.getCellKey(col, row), charId);
  }

  /**
   * Clear reservations for a specific time slot, or all reservations if no argument given.
   * @param {number} [timeSlot] — omit to clear all reservations
   */
  clearReservations(timeSlot) {
    if (timeSlot === undefined) {
      this.reservations.clear();
    } else {
      this.reservations.delete(timeSlot);
    }
  }

  /**
   * Pack (col, row) into a stable integer key for use in Sets and Maps.
   * @param {number} col
   * @param {number} row
   * @returns {number}
   */
  getCellKey(col, row) {
    return row * 10000 + col;
  }

  /**
   * Get the character ID at a cell. Caller must ensure in-bounds.
   * @param {number} col
   * @param {number} row
   * @returns {number}
   */
  getCharId(col, row) {
    return this.cells[col + row * this.cols];
  }

  /**
   * Resize the grid. All state is discarded.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Int32Array(cols * rows);
    this.cells.fill(-1);
    this.occupiedKeys.clear();
    this.reservations.clear();
  }

  /**
   * Reset all cells and state without reallocating arrays.
   */
  clearAll() {
    this.cells.fill(-1);
    this.occupiedKeys.clear();
    this.reservations.clear();
  }
}
