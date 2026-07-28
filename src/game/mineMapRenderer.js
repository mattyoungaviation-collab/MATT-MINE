const ROOM_COLORS = Object.freeze({
  start: '#51e0b4',
  mining: '#27c8e8',
  combat: '#ff6b73',
  mixed: '#ffb83f',
  treasure: '#a96cff',
  guardian: '#ff4fd8'
});

const OBJECT_GLYPHS = Object.freeze({
  player: 'P',
  extraction: 'E',
  guardian: 'G',
  slime: 'S',
  bat: 'B',
  crawler: 'C',
  beetle: 'D',
  exploder: 'X',
  ranged: 'R',
  stone: '●',
  copper: '●',
  gold: '◆',
  crystal: '♦',
  treasure: '▣',
  weapon_blaster: '✦',
  weapon_dynamite: '✹',
  health: '+',
  upgrade: '↑',
  rockfall: '!',
  crystal_field: '!'
});

export function drawCompetitionMap(canvas, map, options = {}) {
  if (!canvas || !map) return;
  const context = canvas.getContext('2d');
  const width = canvas.width || canvas.clientWidth || 1200;
  const height = canvas.height || canvas.clientHeight || 600;
  context.clearRect(0, 0, width, height);
  const bounds = mapBounds(map);
  const scale = Math.min(
    (width - 80) / Math.max(1, bounds.maxX - bounds.minX),
    (height - 80) / Math.max(1, bounds.maxY - bounds.minY)
  );
  const offsetX = (width - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale;
  const offsetY = (height - (bounds.maxY - bounds.minY) * scale) / 2 - bounds.minY * scale;
  const point = (x, y) => ({ x: offsetX + x * scale, y: offsetY + y * scale });
  const byId = new Map((map.rooms || []).map((room) => [room.id, room]));

  const gradient = context.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, width * .65);
  gradient.addColorStop(0, '#171a26');
  gradient.addColorStop(1, '#06070b');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.lineCap = 'round';
  for (const corridor of map.corridors || []) {
    const a = byId.get(corridor.from);
    const b = byId.get(corridor.to);
    if (!a || !b) continue;
    const start = point(a.x, a.y);
    const end = point(b.x, b.y);
    context.strokeStyle = '#343948';
    context.lineWidth = Math.max(12, Number(corridor.width || .7) * scale);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.strokeStyle = 'rgba(255,255,255,.045)';
    context.lineWidth = Math.max(2, Number(corridor.width || .7) * scale - 7);
    context.stroke();
  }

  for (const room of map.rooms || []) {
    const center = point(room.x, room.y);
    const roomWidth = room.width * scale;
    const roomHeight = room.height * scale;
    const color = ROOM_COLORS[room.type] || '#7e8799';
    context.save();
    context.shadowBlur = room.type === 'guardian' ? 24 : 12;
    context.shadowColor = color;
    roundedRect(context, center.x - roomWidth / 2, center.y - roomHeight / 2, roomWidth, roomHeight, 12);
    context.fillStyle = '#171b24';
    context.fill();
    context.lineWidth = room.type === 'guardian' ? 4 : 2;
    context.strokeStyle = color;
    context.stroke();
    context.shadowBlur = 0;
    context.fillStyle = color;
    context.font = `800 ${Math.max(10, Math.min(17, scale * .16))}px Inter, sans-serif`;
    context.textAlign = 'center';
    context.fillText(String(room.name || room.type).toUpperCase(), center.x, center.y - roomHeight / 2 + 22);
    context.restore();
  }

  for (const object of map.objects || []) {
    const room = byId.get(object.roomId);
    if (!room) continue;
    const center = point(
      room.x + Number(object.x || 0) * room.width,
      room.y + Number(object.y || 0) * room.height
    );
    const hostile = ['guardian', 'slime', 'bat', 'crawler', 'beetle', 'exploder', 'ranged'].includes(object.type);
    context.beginPath();
    context.arc(center.x, center.y, object.type === 'guardian' ? 12 : 8, 0, Math.PI * 2);
    context.fillStyle = hostile ? '#ff5670' : object.type === 'player' ? '#52e8bc' : '#ffd541';
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#090a0d';
    context.stroke();
    context.fillStyle = '#090a0d';
    context.font = `900 ${object.type === 'guardian' ? 12 : 9}px Inter, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(OBJECT_GLYPHS[object.type] || '•', center.x, center.y + .5);
    if (object.quantity > 1 && options.hideCounts !== true) {
      context.fillStyle = '#fff';
      context.font = '800 9px Inter, sans-serif';
      context.fillText(`×${object.quantity}`, center.x + 13, center.y - 10);
    }
  }
}

export function mapBounds(map) {
  const rooms = map?.rooms || [];
  if (!rooms.length) return { minX: 0, minY: 0, maxX: 12, maxY: 8 };
  return rooms.reduce((bounds, room) => ({
    minX: Math.min(bounds.minX, room.x - room.width / 2),
    minY: Math.min(bounds.minY, room.y - room.height / 2),
    maxX: Math.max(bounds.maxX, room.x + room.width / 2),
    maxY: Math.max(bounds.maxY, room.y + room.height / 2)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
