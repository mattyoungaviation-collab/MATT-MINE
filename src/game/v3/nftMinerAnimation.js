export const NFT_MINER_ATLAS_COLUMNS = 6;
export const NFT_MINER_ATLAS_ROWS = 4;

export const NFT_MINER_ACTION_DURATION = Object.freeze({
  pickaxe: 0.36,
  blaster: 0.24,
  dynamite: 0.48
});

const NFT_MINER_EVOLUTIONS = Object.freeze([
  Object.freeze({ minimumLevel: 100, asset: 'nftMineLegendAtlas', file: 'mine-legend-atlas-v1.png' }),
  Object.freeze({ minimumLevel: 75, asset: 'nftEliteAtlas', file: 'elite-atlas-v1.png' }),
  Object.freeze({ minimumLevel: 50, asset: 'nftVaultRaiderAtlas', file: 'vault-raider-atlas-v1.png' }),
  Object.freeze({ minimumLevel: 35, asset: 'nftVeteranAtlas', file: 'veteran-atlas-v1.png' }),
  Object.freeze({ minimumLevel: 25, asset: 'nftCrystalHunterAtlas', file: 'crystal-hunter-atlas-v1.png' }),
  Object.freeze({ minimumLevel: 10, asset: 'nftApprenticeAtlas', file: 'apprentice-atlas-v1.png' }),
  Object.freeze({ minimumLevel: 1, asset: 'nftRookieAtlas', file: 'rookie-atlas-v1.png' })
]);

const WEAPON_ROWS = Object.freeze({
  pickaxe: 1,
  blaster: 2,
  dynamite: 3
});

const WALK_COLUMNS = Object.freeze([1, 2, 3, 2]);
const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

export function nftMinerAtlasAssetForLevel(level) {
  const normalizedLevel = Math.max(1, Math.floor(Number(level) || 1));
  return NFT_MINER_EVOLUTIONS.find((evolution) => normalizedLevel >= evolution.minimumLevel)?.asset
    || 'nftRookieAtlas';
}

export function nftMinerAtlasSourceForLevel(level) {
  const normalizedLevel = Math.max(1, Math.floor(Number(level) || 1));
  const file = NFT_MINER_EVOLUTIONS.find((evolution) => normalizedLevel >= evolution.minimumLevel)?.file
    || 'rookie-atlas-v1.png';
  return `/assets/game/nft-evolution/${file}`;
}

export function nftMinerActionDuration(weapon) {
  return NFT_MINER_ACTION_DURATION[weapon] || NFT_MINER_ACTION_DURATION.pickaxe;
}

export function nftMinerVisualDirection(player, movement = 0) {
  const moving = movement > 22;
  const actionAngle = player.swingTimer > 0 && Number.isFinite(player.actionAngle)
    ? player.actionAngle
    : null;
  const dashAngle = player.dashTimer > 0 && Number.isFinite(player.dashAngle)
    ? player.dashAngle
    : null;
  const movementAngle = moving && Number.isFinite(player.vx) && Number.isFinite(player.vy)
    ? (Number.isFinite(player.visualAngle) ? player.visualAngle : Math.atan2(player.vy, player.vx))
    : null;
  const angle = normalizeAngle(
    actionAngle ?? dashAngle ?? movementAngle ?? player.visualAngle ?? player.angle ?? 0
  );
  const horizontal = Math.cos(angle);
  const vertical = Math.sin(angle);
  const verticalFacing = Math.abs(vertical) > Math.abs(horizontal) * 1.08;
  const facingSign = verticalFacing
    ? (Number(player.visualFacingSign) < 0 ? -1 : 1)
    : (horizontal < 0 ? -1 : 1);
  const direction = verticalFacing
    ? (vertical < 0 ? 'north' : 'south')
    : (facingSign < 0 ? 'west' : 'east');

  return {
    angle,
    direction,
    facingSign,
    verticalFacing,
    depth: Math.max(-1, Math.min(1, vertical))
  };
}

export function nftMinerMotionTransform(player, movement, elapsed, actionProgress = 0) {
  const direction = nftMinerVisualDirection(player, movement);
  const moving = movement > 22;
  const dashing = player.dashTimer > 0;
  const attacking = player.swingTimer > 0;
  const walkCycle = Number.isFinite(player.walkCycle)
    ? player.walkCycle
    : elapsed * Math.max(1, movement / 34);
  const step = Math.sin(walkCycle * TAU);
  const footPlant = Math.abs(Math.sin(walkCycle * Math.PI));
  const dashForward = dashing ? 8 : 0;
  const actionForward = attacking ? Math.sin(actionProgress * Math.PI) * 7 : 0;
  const forward = dashForward + actionForward;
  const recoil = attacking && player.weapon === 'blaster'
    ? Math.sin(actionProgress * Math.PI) * -3
    : 0;

  return {
    ...direction,
    offsetX: Math.cos(direction.angle) * (forward + recoil) + (moving && !dashing ? step * 0.8 : 0),
    offsetY: Math.sin(direction.angle) * (forward + recoil) - (moving && !dashing ? footPlant * 1.15 : Math.sin(elapsed * 3.2) * 0.55),
    rotation: dashing
      ? Math.cos(direction.angle) * 0.14
      : attacking && !direction.verticalFacing
        ? direction.facingSign * -Math.sin(actionProgress * Math.PI) * 0.045
        : 0,
    scaleX: dashing ? 1.09 : direction.verticalFacing ? 0.94 : 1,
    scaleY: dashing ? 0.82 : direction.direction === 'south' ? 1.025 : direction.direction === 'north' ? 0.975 : 1,
    shadowStretch: dashing ? 1.55 : 1,
    shadowRotation: dashing ? direction.angle : 0
  };
}

export function nftMinerAnimationFrame(player, movement, elapsed) {
  if (player.health <= 0) return { row: 0, column: 5, progress: 1 };
  if (player.hitFlash > 0) return { row: 0, column: 4, progress: 1 };

  if (player.swingTimer > 0) {
    const duration = nftMinerActionDuration(player.weapon);
    const progress = Math.max(0, Math.min(0.999, 1 - player.swingTimer / duration));
    return {
      row: WEAPON_ROWS[player.weapon] || WEAPON_ROWS.pickaxe,
      column: Math.floor(progress * NFT_MINER_ATLAS_COLUMNS),
      progress
    };
  }

  if (player.dashTimer > 0) {
    return { row: 0, column: 3, progress: 0 };
  }

  if (movement > 22) {
    const walkCycle = Number.isFinite(player.walkCycle) ? player.walkCycle : elapsed * 1.75;
    return {
      row: 0,
      column: WALK_COLUMNS[Math.floor(walkCycle * WALK_COLUMNS.length) % WALK_COLUMNS.length],
      progress: 0
    };
  }

  return { row: 0, column: 0, progress: 0 };
}

function normalizeAngle(value) {
  let angle = Number(value) || 0;
  while (angle > Math.PI) angle -= TAU;
  while (angle < -Math.PI) angle += TAU;
  if (Math.abs(angle) < 1e-9) return 0;
  if (Math.abs(Math.abs(angle) - HALF_PI) < 1e-9) return Math.sign(angle) * HALF_PI;
  return angle;
}
