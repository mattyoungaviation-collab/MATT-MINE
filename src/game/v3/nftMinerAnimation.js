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

  if (movement > 22) {
    const walkRate = player.dashTimer > 0 ? 12 : 7;
    return {
      row: 0,
      column: 1 + Math.floor(elapsed * walkRate) % 3,
      progress: 0
    };
  }

  return { row: 0, column: 0, progress: 0 };
}
