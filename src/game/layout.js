import { CONFIG } from './config.js';
import { random, randomInt } from './utils.js';

const GRID = Object.freeze({
  columns: 4,
  rows: 3,
  left: 95,
  top: 130,
  horizontalGap: 190,
  verticalGap: 220
});

const DIRECTIONS = Object.freeze([
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 }
]);

export function createMineLayout(roomCount = CONFIG.roomsPerDepth, options = {}) {
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

  const standardWidth = positiveNumber(options.roomWidth, CONFIG.roomWidth);
  const standardHeight = positiveNumber(options.roomHeight, CONFIG.roomHeight);
  const rooms = cells.map((cell, index) => ({
    id: index + 1,
    cellX: cell.x,
    cellY: cell.y,
    x: 0,
    y: 0,
    width: standardWidth,
    height: standardHeight,
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
  if (options.applyGuardianRoomTuning === true) {
    guardianRoom.width = Math.max(standardWidth, positiveNumber(options.bossRoomWidth, 520));
    guardianRoom.height = Math.max(standardHeight, positiveNumber(options.bossRoomHeight, 390));
  }
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

  positionRooms(rooms, options);

  const corridors = [];
  for (const room of rooms) {
    if (!room.parent) continue;
    const parent = rooms.find((entry) => entry.cellX === room.parent.x && entry.cellY === room.parent.y);
    if (!parent) continue;
    corridors.push(makeCorridor(parent, room, Number(options.corridorWidth || CONFIG.corridorWidth)));
  }

  return { rooms, corridors, startRoom, guardianRoom, treasureRoom, bounds: layoutBounds(rooms, corridors) };
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

export function movementBounds(layout, radius = 0) {
  const bounds = layout?.bounds || layoutBounds(layout?.rooms || [], layout?.corridors || []);
  return {
    minX: Math.min(radius, bounds.left + radius),
    maxX: Math.max(CONFIG.worldWidth - radius, bounds.right - radius),
    minY: Math.min(radius, bounds.top + radius),
    maxY: Math.max(CONFIG.worldHeight - radius, bounds.bottom - radius)
  };
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

function makeCorridor(a, b, corridorWidth) {
  if (a.cellY === b.cellY) {
    const left = a.x <= b.x ? a : b;
    const right = left === a ? b : a;
    const start = left.x + left.width / 2 - corridorWidth / 2;
    const end = right.x - right.width / 2 + corridorWidth / 2;
    return {
      x: (start + end) / 2,
      y: a.y,
      width: Math.max(corridorWidth, end - start),
      height: corridorWidth,
      orientation: 'horizontal'
    };
  }
  const top = a.y <= b.y ? a : b;
  const bottom = top === a ? b : a;
  const start = top.y + top.height / 2 - corridorWidth / 2;
  const end = bottom.y - bottom.height / 2 + corridorWidth / 2;
  return {
    x: a.x,
    y: (start + end) / 2,
    width: corridorWidth,
    height: Math.max(corridorWidth, end - start),
    orientation: 'vertical'
  };
}

function positionRooms(rooms, options) {
  const fallbackWidth = positiveNumber(options.roomWidth, CONFIG.roomWidth);
  const fallbackHeight = positiveNumber(options.roomHeight, CONFIG.roomHeight);
  const columnWidths = Array.from({ length: GRID.columns }, (_, column) => Math.max(
    fallbackWidth,
    ...rooms.filter((room) => room.cellX === column).map((room) => room.width)
  ));
  const rowHeights = Array.from({ length: GRID.rows }, (_, row) => Math.max(
    fallbackHeight,
    ...rooms.filter((room) => room.cellY === row).map((room) => room.height)
  ));
  const horizontalGap = positiveNumber(options.roomHorizontalGap, GRID.horizontalGap);
  const verticalGap = positiveNumber(options.roomVerticalGap, GRID.verticalGap);
  const columns = centersForSizes(columnWidths, GRID.left, horizontalGap);
  const rows = centersForSizes(rowHeights, GRID.top, verticalGap);
  for (const room of rooms) {
    room.x = columns[room.cellX];
    room.y = rows[room.cellY];
  }
}

function centersForSizes(sizes, leadingPadding, gap) {
  const centers = [];
  let edge = leadingPadding;
  for (const size of sizes) {
    centers.push(edge + size / 2);
    edge += size + gap;
  }
  return centers;
}

function layoutBounds(rooms, corridors) {
  const areas = [...rooms, ...corridors];
  if (!areas.length) return { left: 0, right: CONFIG.worldWidth, top: 0, bottom: CONFIG.worldHeight };
  return {
    left: Math.min(...areas.map((area) => area.x - area.width / 2)),
    right: Math.max(...areas.map((area) => area.x + area.width / 2)),
    top: Math.min(...areas.map((area) => area.y - area.height / 2)),
    bottom: Math.max(...areas.map((area) => area.y + area.height / 2))
  };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pointInRect(rect, x, y, padding) {
  return x >= rect.x - rect.width / 2 + padding &&
    x <= rect.x + rect.width / 2 - padding &&
    y >= rect.y - rect.height / 2 + padding &&
    y <= rect.y + rect.height / 2 - padding;
}

function validCell(cell) {
  return cell.x >= 0 && cell.x < GRID.columns && cell.y >= 0 && cell.y < GRID.rows;
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
