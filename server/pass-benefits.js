export const MINE_PASS_GAMEPLAY_MULTIPLIER = 2;

export function applyMinePassGameplayBenefits(tuning, active) {
  const enabled = active === true;
  tuning._minePassBenefits = {
    active: enabled,
    xpMultiplier: enabled ? MINE_PASS_GAMEPLAY_MULTIPLIER : 1
  };
  if (!enabled) return tuning;
  const xpBase = Number(tuning.xpMultiplier ?? 1);
  tuning.xpMultiplier = (Number.isFinite(xpBase) && xpBase > 0 ? xpBase : 1) * MINE_PASS_GAMEPLAY_MULTIPLIER;
  return tuning;
}
