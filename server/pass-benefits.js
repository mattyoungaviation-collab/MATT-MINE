export const MINE_PASS_GAMEPLAY_MULTIPLIER = 2;

export function applyMinePassGameplayBenefits(tuning, active) {
  const enabled = active === true;
  tuning._minePassBenefits = {
    active: enabled,
    xpMultiplier: enabled ? MINE_PASS_GAMEPLAY_MULTIPLIER : 1,
    nuggetMultiplier: enabled ? MINE_PASS_GAMEPLAY_MULTIPLIER : 1
  };
  if (!enabled) return tuning;
  tuning.xpMultiplier = Number(tuning.xpMultiplier || 0) * MINE_PASS_GAMEPLAY_MULTIPLIER;
  tuning.nuggetMultiplier = Number(tuning.nuggetMultiplier || 0) * MINE_PASS_GAMEPLAY_MULTIPLIER;
  return tuning;
}
