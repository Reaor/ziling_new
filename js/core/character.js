/**
 * Character — A single Chinese character agent on the grid.
 * @module character
 */

export const CHAR_STATE = {
  IDLE: 'idle',
  PLANNING: 'planning',
  MOVING: 'moving',
  DISSOLVING: 'dissolving',
  SPAWNING: 'spawning'
};

export class Character {
  constructor(id, char, gridX, gridY) {
    this.id = id;
    this.char = char;
    this.gridX = gridX;
    this.gridY = gridY;
    this.targetGridX = gridX;
    this.targetGridY = gridY;
    this.displayX = 0;
    this.displayY = 0;
    this.microOffsetX = 0;
    this.microOffsetY = 0;
    this.prevGridX = gridX;
    this.prevGridY = gridY;
    this.path = [];
    this.pathTimeSlot = 0;
    this.color = '#e0e0e0';
    this.alpha = 1.0;
    this.state = CHAR_STATE.IDLE;
    this.region = null;
    this.anchorX = gridX;
    this.anchorY = gridY;
    this.shapeOffsetX = 0;
    this.shapeOffsetY = 0;
  }

  reset(char, gridX, gridY) {
    this.char = char;
    this.gridX = gridX;
    this.gridY = gridY;
    this.targetGridX = gridX;
    this.targetGridY = gridY;
    this.displayX = 0;
    this.displayY = 0;
    this.microOffsetX = 0;
    this.microOffsetY = 0;
    this.prevGridX = gridX;
    this.prevGridY = gridY;
    this.path = [];
    this.pathTimeSlot = 0;
    this.color = '#e0e0e0';
    this.alpha = 1.0;
    this.state = CHAR_STATE.IDLE;
    this.region = null;
    this.anchorX = gridX;
    this.anchorY = gridY;
    this.shapeOffsetX = 0;
    this.shapeOffsetY = 0;
  }
}

export class CharacterPool {
  constructor(maxSize = 200) {
    this.pool = [];
    this.active = new Map();
    this.nextId = 0;
    this._preCreate(maxSize);
  }

  _preCreate(size) {
    for (let i = 0; i < size; i++) {
      this.pool.push(new Character(0, '', 0, 0));
    }
  }

  acquire(char, gridX, gridY) {
    const id = this.nextId++;
    let character;
    if (this.pool.length > 0) {
      character = this.pool.pop();
      character.reset(char, gridX, gridY);
    } else {
      character = new Character(id, char, gridX, gridY);
    }
    character.id = id;
    this.active.set(id, character);
    return character;
  }

  release(charId) {
    const character = this.active.get(charId);
    if (!character) return;
    character.reset('', 0, 0);
    this.active.delete(charId);
    this.pool.push(character);
  }

  get(charId) {
    return this.active.get(charId);
  }

  getAll() {
    return Array.from(this.active.values());
  }

  count() {
    return this.active.size;
  }

  isActive(charId) {
    return this.active.has(charId);
  }
}
