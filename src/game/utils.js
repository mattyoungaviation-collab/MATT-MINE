export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const angleTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
export const randomRange = (min, max) => min + Math.random() * (max - min);
export const randomInt = (min, max) => Math.floor(randomRange(min, max + 1));
export const formatNumber = (value) => Math.floor(value).toLocaleString('en-US');

export function weightedChoice(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return entries.at(-1);
}

export function pickUnique(items, count) {
  const pool = [...items];
  const picked = [];
  while (pool.length && picked.length < count) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

export function circleCollision(a, b, padding = 0) {
  return distance(a, b) < (a.radius || 0) + (b.radius || 0) + padding;
}
