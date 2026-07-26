const TAU = Math.PI * 2;

export const ENEMY_STATS = Object.freeze({
  slime: { radius: 21, health: 48, speed: 78, damage: 9, xp: 14, color: '#e94f64' },
  bat: { radius: 16, health: 32, speed: 132, damage: 7, xp: 11, color: '#ff8b5e' },
  crawler: { radius: 25, health: 74, speed: 66, damage: 13, xp: 20, color: '#d94b9d' },
  beetle: { radius: 27, health: 96, speed: 58, damage: 16, xp: 25, color: '#5dbb84' },
  exploder: { radius: 22, health: 44, speed: 86, damage: 24, xp: 18, color: '#ffb342' },
  spitter: { radius: 20, health: 58, speed: 74, damage: 22, xp: 22, color: '#55d7c8' },
  guardian: { radius: 56, health: 820, speed: 62, damage: 25, xp: 180, color: '#b843f0' }
});

export function enemyArchetypeForRoll(roll, depth = 1) {
  const normalized = Math.max(0, Math.min(0.999999, roll));
  if (depth >= 2 && normalized >= 0.93) return 'exploder';
  if (normalized >= 0.82) return 'spitter';
  if (normalized >= 0.7) return 'beetle';
  if (normalized >= 0.47) return 'crawler';
  if (normalized >= 0.24) return 'bat';
  return 'slime';
}

export function bossPhaseForHealth(hp, maxHp) {
  const fraction = maxHp > 0 ? hp / maxHp : 0;
  if (fraction <= 0.34) return 3;
  if (fraction <= 0.68) return 2;
  return 1;
}

export function frontArmorMultiplier(enemyFacing, impactAngle) {
  const attackerDirection = normalizeAngle(impactAngle + Math.PI);
  const difference = Math.abs(normalizeAngle(attackerDirection - enemyFacing));
  return difference < 0.9 ? 0.08 : 1;
}

export function roomRequiresLock(type) {
  return type === 'combat' || type === 'guardian';
}

export function normalizeAngle(angle) {
  let value = angle % TAU;
  if (value > Math.PI) value -= TAU;
  if (value < -Math.PI) value += TAU;
  return value;
}
