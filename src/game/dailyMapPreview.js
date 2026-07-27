import { CONFIG } from './config.js';
import { createMineLayout } from './layout.js';
import { seededRandom, withRandomSource } from './utils.js';

const FLOOR_ART = '/assets/game/mine-floor-cinematic.webp';
const DEFAULT_DAY = () => new Date().toISOString().slice(0, 10);
const ROOM_COLORS = Object.freeze({
  start: '#f4c542',
  mining: '#50d7f2',
  combat: '#ec6d67',
  treasure: '#f0a83f',
  guardian: '#ad6aff',
  mixed: '#87a0b6'
});

let floorImage = null;
let floorImagePromise = null;

export function freeDailyMineSeed(day = DEFAULT_DAY()) {
  return `MATT-MINE-${day}-FREE`;
}

export function createDailyMinePreviewModel(day = DEFAULT_DAY(), tuning = {}) {
  const normalizedDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : DEFAULT_DAY();
  const seed = freeDailyMineSeed(normalizedDay);
  const layout = withRandomSource(
    seededRandom(`${seed}:DEPTH:1`),
    () => createMineLayout(Number(tuning.roomsPerDepth || CONFIG.roomsPerDepth), tuning)
  );

  if (layout.guardianRoom) {
    layout.guardianRoom.width = Math.max(layout.guardianRoom.width, Number(tuning.bossRoomWidth || 520));
    layout.guardianRoom.height = Math.max(layout.guardianRoom.height, Number(tuning.bossRoomHeight || 390));
  }

  const left = Math.min(...[...layout.rooms, ...layout.corridors].map((area) => area.x - area.width / 2));
  const right = Math.max(...[...layout.rooms, ...layout.corridors].map((area) => area.x + area.width / 2));
  const top = Math.min(...[...layout.rooms, ...layout.corridors].map((area) => area.y - area.height / 2));
  const bottom = Math.max(...[...layout.rooms, ...layout.corridors].map((area) => area.y + area.height / 2));

  return {
    day: normalizedDay,
    seed,
    rooms: layout.rooms.map((room) => ({ ...room })),
    corridors: layout.corridors.map((corridor) => ({ ...corridor })),
    bounds: { left, right, top, bottom }
  };
}

export function mountDailyMinePreviews(options = {}) {
  const canvases = [...document.querySelectorAll('[data-daily-mine-preview]')];
  if (!canvases.length) return () => {};
  const model = createDailyMinePreviewModel(options.day, options.tuning);
  const renderAll = () => {
    for (const canvas of canvases) renderDailyMinePreview(canvas, model, floorImage);
  };
  renderAll();
  void loadFloorImage().then(renderAll);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(renderAll) : null;
  for (const canvas of canvases) observer?.observe(canvas);
  return () => observer?.disconnect();
}

export function renderDailyMinePreview(canvas, model, image = null) {
  const cssWidth = Math.max(280, Math.round(canvas.clientWidth || Number(canvas.width) || 960));
  const cssHeight = Math.max(110, Math.round(canvas.clientHeight || Number(canvas.height) || 220));
  const pixelRatio = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
  const targetWidth = Math.round(cssWidth * pixelRatio);
  const targetHeight = Math.round(cssHeight * pixelRatio);
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  drawPhotoBackdrop(context, image, cssWidth, cssHeight);

  const padding = Math.max(18, Math.min(34, cssWidth * 0.035));
  const worldWidth = Math.max(1, model.bounds.right - model.bounds.left);
  const worldHeight = Math.max(1, model.bounds.bottom - model.bounds.top);
  const scale = Math.min((cssWidth - padding * 2) / worldWidth, (cssHeight - padding * 2) / worldHeight);
  const offsetX = (cssWidth - worldWidth * scale) / 2 - model.bounds.left * scale;
  const offsetY = (cssHeight - worldHeight * scale) / 2 - model.bounds.top * scale;
  const project = (area) => ({
    x: area.x * scale + offsetX,
    y: area.y * scale + offsetY,
    width: area.width * scale,
    height: area.height * scale
  });

  context.save();
  context.shadowColor = 'rgba(0, 0, 0, 0.9)';
  context.shadowBlur = 16;
  for (const corridor of model.corridors) {
    drawMineArea(context, project(corridor), image, cssWidth, cssHeight, '#53606c', 0.64, 8);
  }
  context.restore();

  for (const room of model.rooms) {
    const rect = project(room);
    const color = ROOM_COLORS[room.type] || ROOM_COLORS.mixed;
    drawMineArea(context, rect, image, cssWidth, cssHeight, color, 0.86, 12);
    drawRoomContents(context, room, rect, color, scale);
  }
  drawVignette(context, cssWidth, cssHeight);
}

function loadFloorImage() {
  if (floorImagePromise) return floorImagePromise;
  if (typeof Image !== 'function') return Promise.resolve(null);
  floorImagePromise = new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      floorImage = image;
      resolve(image);
    };
    image.onerror = () => resolve(null);
    image.src = FLOOR_ART;
  });
  return floorImagePromise;
}

function drawPhotoBackdrop(context, image, width, height) {
  context.fillStyle = '#05080d';
  context.fillRect(0, 0, width, height);
  if (image) {
    drawImageCover(context, image, 0, 0, width, height);
    context.fillStyle = 'rgba(2, 5, 10, 0.83)';
    context.fillRect(0, 0, width, height);
  }
  const glow = context.createRadialGradient(width * 0.72, height * 0.48, 0, width * 0.72, height * 0.48, width * 0.45);
  glow.addColorStop(0, 'rgba(115, 55, 178, 0.24)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
}

function drawMineArea(context, rect, image, canvasWidth, canvasHeight, color, brightness, radius) {
  const x = rect.x - rect.width / 2;
  const y = rect.y - rect.height / 2;
  const safeRadius = Math.min(radius, rect.width / 4, rect.height / 4);
  context.save();
  roundedRect(context, x, y, rect.width, rect.height, safeRadius);
  context.clip();
  context.fillStyle = '#1b1d20';
  context.fillRect(x, y, rect.width, rect.height);
  if (image) {
    context.globalAlpha = brightness;
    drawImageCover(context, image, 0, 0, canvasWidth, canvasHeight);
  } else {
    const floor = context.createLinearGradient(x, y, x + rect.width, y + rect.height);
    floor.addColorStop(0, '#272927');
    floor.addColorStop(0.5, '#15191b');
    floor.addColorStop(1, '#2a241d');
    context.fillStyle = floor;
    context.fillRect(x, y, rect.width, rect.height);
  }
  context.globalAlpha = 1;
  context.fillStyle = `${color}18`;
  context.fillRect(x, y, rect.width, rect.height);
  context.restore();

  context.save();
  roundedRect(context, x, y, rect.width, rect.height, safeRadius);
  context.lineWidth = Math.max(1.5, Math.min(4, rect.width * 0.02));
  context.strokeStyle = `${color}cc`;
  context.shadowColor = color;
  context.shadowBlur = 10;
  context.stroke();
  context.restore();
}

function drawRoomContents(context, room, rect, color, scale) {
  const compact = rect.width < 92 || rect.height < 62;
  const markerSize = Math.max(3, Math.min(7, 4.5 * scale));
  context.save();
  context.translate(rect.x, rect.y);
  if (room.type === 'start') drawLiftIcon(context, markerSize, color);
  if (room.type === 'mining') drawOreIcons(context, markerSize, color);
  if (room.type === 'combat' || room.type === 'mixed') drawEnemyIcons(context, markerSize, color);
  if (room.type === 'treasure') drawCacheIcon(context, markerSize, color);
  if (room.type === 'guardian') drawGuardianIcon(context, markerSize, color);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#ffffff';
  context.shadowColor = 'rgba(0, 0, 0, 1)';
  context.shadowBlur = 5;
  context.font = `900 ${compact ? 7 : Math.min(11, Math.max(8, rect.width * 0.085))}px Inter, ui-sans-serif, system-ui, sans-serif`;
  context.fillText(compact ? shortRoomName(room) : room.name.toUpperCase(), 0, rect.height * 0.27);
  context.restore();
}

function drawLiftIcon(context, size, color) {
  context.fillStyle = color;
  context.fillRect(-size * 1.8, -size * 1.8, size * 3.6, size * 2.8);
  context.fillStyle = '#1b1b13';
  context.fillRect(-size * 0.65, -size * 1.25, size * 1.3, size * 2.25);
}

function drawOreIcons(context, size, color) {
  for (const [x, y, multiplier] of [[-1.8, 0, 1], [0, -1.2, 1.35], [1.7, 0.4, 0.85]]) {
    context.save();
    context.translate(x * size, y * size);
    context.rotate(Math.PI / 4);
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = size * 2;
    context.fillRect(-size * multiplier / 2, -size * multiplier, size * multiplier, size * 2 * multiplier);
    context.restore();
  }
}

function drawEnemyIcons(context, size, color) {
  for (const x of [-1.3, 1.3]) {
    context.beginPath();
    context.arc(x * size, -size * 0.25, size * 0.8, Math.PI, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.fillStyle = '#fff3d6';
    context.fillRect(x * size - size * 0.38, -size * 0.35, size * 0.2, size * 0.2);
    context.fillRect(x * size + size * 0.18, -size * 0.35, size * 0.2, size * 0.2);
  }
}

function drawCacheIcon(context, size, color) {
  context.fillStyle = '#5e3519';
  context.fillRect(-size * 2, -size, size * 4, size * 2.25);
  context.fillStyle = color;
  context.fillRect(-size * 2.1, -size * 0.35, size * 4.2, size * 0.65);
  context.fillRect(-size * 0.3, -size, size * 0.6, size * 2.25);
}

function drawGuardianIcon(context, size, color) {
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = size * 3;
  context.beginPath();
  context.moveTo(0, -size * 2.4);
  context.lineTo(size * 2, -size * 0.5);
  context.lineTo(size * 1.4, size * 1.7);
  context.lineTo(-size * 1.4, size * 1.7);
  context.lineTo(-size * 2, -size * 0.5);
  context.closePath();
  context.fill();
  context.fillStyle = '#f4dcff';
  context.fillRect(-size * 0.3, -size * 0.9, size * 0.6, size * 1.5);
}

function drawVignette(context, width, height) {
  const vignette = context.createRadialGradient(width / 2, height / 2, height * 0.1, width / 2, height / 2, width * 0.62);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(0.72, 'rgba(0, 0, 0, 0.1)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.8)');
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}

function drawImageCover(context, image, x, y, width, height) {
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;
  let sourceX = 0;
  let sourceY = 0;
  if (imageRatio > targetRatio) {
    sourceWidth = image.naturalHeight * targetRatio;
    sourceX = (image.naturalWidth - sourceWidth) / 2;
  } else {
    sourceHeight = image.naturalWidth / targetRatio;
    sourceY = (image.naturalHeight - sourceHeight) / 2;
  }
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function shortRoomName(room) {
  return {
    start: 'LIFT',
    mining: 'ORE',
    combat: 'FIGHT',
    treasure: 'CACHE',
    guardian: 'BOSS',
    mixed: 'DEEP'
  }[room.type] || 'MINE';
}

export const DAILY_MINE_PREVIEW_FLOOR_ART = FLOOR_ART;
