import { CONFIG } from './config.js';
import { random, randomInt } from './utils.js';

const GRID = Object.freeze({
  columns: [300, 900, 1500, 2100],
  rows: [280, 800, 1320]
});

const DIRECTIONS = Object.freeze([
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 }
]);

export function createMineLayout(roomCount = CONFIG.roomsPerDepth) {
  const startCell = { x: 1, y: 1 };
  const cells = [{ ...startCell, parent: null }];
  const seen = new Set([cellKey(startCell)]);
  let cursor = startCell;
  let safety = 0;

  while (cells.length < roomCount && safety < 500) {
    safety += 1;
    const direction = DIRECTIONS[randomInt(0, DIRECTIONS.length - 1)];
    const next = { x: cursor.x + direction.x, y: cursor.y + direction.y };
    if (!validCell(next)) {
      cursor = cells[randomInt(0, cells.length - 1)];
      continue;
    }
    const key = cellKey(next);
    if (seen.has(key)) {
      cursor = next;
      continue;
    }
    const parent = { ...cursor };
    cells.push({ ...next, parent });
    seen.add(key);
    cursor = next;
  }

  while (cells.length < roomCount) {
    const candidates = [];
    for (const room of cells) {
      for (const direction of DIRECTIONS) {
        const next = { x: room.x + direction.x, y: room.y + direction.y };
        if (validCell(next) && !seen.has(cellKey(next))) candidates.push({ next, parent: room });
      }
    }
    if (!candidates.length) break;
    const picked = candidates[randomInt(0, candidates.length - 1)];
    cells.push({ ...picked.next, parent: { x: picked.parent.x, y: picked.parent.y } });
    seen.add(cellKey(picked.next));
  }

  const rooms = cells.map((cell, index) => ({
    id: index + 1,
    cellX: cell.x,
    cellY: cell.y,
    x: GRID.columns[cell.x],
    y: GRID.rows[cell.y],
    width: CONFIG.roomWidth,
    height: CONFIG.roomHeight,
    parent: cell.parent,
    type: 'mixed',
    name: 'Old Workings'
  }));

  const startRoom = rooms.find((room) => room.cellX === startCell.x && room.cellY === startCell.y) || rooms[0];
  const sortedByDistance = [...rooms].sort((a, b) => gridDistance(startRoom, b) - gridDistance(startRoom, a));
  const guardianRoom = sortedByDistance[0];
  const treasureRoom = sortedByDistance.find((room) => room.id !== guardianRoom.id && room.id !== startRoom.id) || sortedByDistance[1];

  startRoom.type = 'start';
  startRoom.name = 'Lift Station';
  guardianRoom.type = 'guardian';
  guardianRoom.name = 'Guardian Vault';
  if (treasureRoom) {
    treasureRoom.type = 'treasure';
    treasureRoom.name = 'Prospector Cache';
  }

  const remaining = rooms.filter((room) => !['start', 'guardian', 'treasure'].includes(room.type));
  shuffleInPlace(remaining);
  remaining.forEach((room, index) => {
    if (index < 2) {
      room.type = 'mining';
      room.name = index === 0 ? 'Crystal Vein' : 'Gold Cut';
    } else if (index < 4) {
      room.type = 'combat';
      room.name = index === 2 ? 'Crawler Nest' : 'Collapsed Camp';
    } else {
      room.type = 'mixed';
      room.name = 'Old Workings';
    }
  });

  const corridors = [];
  for (const room of rooms) {
    if (!room.parent) continue;
    const parent = rooms.find((entry) => entry.cellX === room.parent.x && entry.cellY === room.parent.y);
    if (!parent) continue;
    corridors.push(makeCorridor(parent, room));
  }

  return { rooms, corridors, startRoom, guardianRoom, treasureRoom };
}

export function pointInLayout(layout, x, y, padding = 0) {
  return layout.rooms.some((room) => pointInRect(room, x, y, padding)) ||
    layout.corridors.some((corridor) => pointInRect(corridor, x, y, padding));
}

export function segmentInLayout(layout, startX, startY, endX, endY, padding = 0, stepSize = 8) {
  const length = Math.hypot(endX - startX, endY - startY);
  const steps = Math.max(1, Math.ceil(length / Math.max(2, stepSize)));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    if (!pointInLayout(
      layout,
      startX + (endX - startX) * progress,
      startY + (endY - startY) * progress,
      padding
    )) return false;
  }
  return true;
}

export function roomAt(layout, x, y) {
  return layout.rooms.find((room) => pointInRect(room, x, y, 0)) || null;
}

export function randomPointInRoom(room, margin = 45) {
  const halfWidth = room.width / 2 - margin;
  const halfHeight = room.height / 2 - margin;
  return {
    x: room.x + (random() * 2 - 1) * Math.max(10, halfWidth),
    y: room.y + (random() * 2 - 1) * Math.max(10, halfHeight)
  };
}

function makeCorridor(a, b) {
  if (a.cellY === b.cellY) {
    return {
      x: (a.x + b.x) / 2,
      y: a.y,
      width: Math.abs(a.x - b.x),
      height: CONFIG.corridorWidth,
      orientation: 'horizontal'
    };
  }
  return {
    x: a.x,
    y: (a.y + b.y) / 2,
    width: CONFIG.corridorWidth,
    height: Math.abs(a.y - b.y),
    orientation: 'vertical'
  };
}

function pointInRect(rect, x, y, padding) {
  return x >= rect.x - rect.width / 2 + padding &&
    x <= rect.x + rect.width / 2 - padding &&
    y >= rect.y - rect.height / 2 + padding &&
    y <= rect.y + rect.height / 2 - padding;
}

function validCell(cell) {
  return cell.x >= 0 && cell.x < GRID.columns.length && cell.y >= 0 && cell.y < GRID.rows.length;
}

function gridDistance(a, b) {
  return Math.abs(a.cellX - b.cellX) + Math.abs(a.cellY - b.cellY);
}

function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

function shuffleInPlace(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
}
