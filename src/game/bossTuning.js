export const BOSS_PHASES = Object.freeze([1, 2, 3]);
export const BOSS_ATTACKS = Object.freeze(['slam', 'volley', 'radial', 'summon']);

const PHASE_DEFAULTS = Object.freeze({
  1: Object.freeze({
    healthThreshold: 1,
    attackSpeedMultiplier: 0.9,
    damageMultiplier: 0.85,
    globalCooldown: 1.7,
    repeatCooldown: 3.2,
    movementSpeed: 0.86,
    chasePressure: 3.5,
    summonCooldown: 9,
    maxSummons: 2
  }),
  2: Object.freeze({
    healthThreshold: 0.66,
    attackSpeedMultiplier: 1.05,
    damageMultiplier: 1,
    globalCooldown: 1.25,
    repeatCooldown: 2.5,
    movementSpeed: 1.15,
    chasePressure: 4.8,
    summonCooldown: 6,
    maxSummons: 4
  }),
  3: Object.freeze({
    healthThreshold: 0.33,
    attackSpeedMultiplier: 1.2,
    damageMultiplier: 1.12,
    globalCooldown: 0.9,
    repeatCooldown: 1.8,
    movementSpeed: 1.55,
    chasePressure: 6.5,
    summonCooldown: 4.5,
    maxSummons: 6
  })
});

const ATTACK_DEFAULTS = Object.freeze({
  slam: Object.freeze({
    enabled: true, cooldown: 3.6, damage: 0.92, projectileSpeed: 0,
    projectileCount: 0, spread: 0, range: 205, windup: 0.3, duration: 0.42, weight: 4
  }),
  volley: Object.freeze({
    enabled: true, cooldown: 2.8, damage: 0.62, projectileSpeed: 345,
    projectileCount: 5, spread: 1.15, range: 560, windup: 0.22, duration: 0.3, weight: 5
  }),
  radial: Object.freeze({
    enabled: true, cooldown: 5.2, damage: 0.58, projectileSpeed: 390,
    projectileCount: 12, spread: Math.PI * 2, range: 600, windup: 0.45, duration: 0.55, weight: 2
  }),
  summon: Object.freeze({
    enabled: true, cooldown: 6, damage: 0, projectileSpeed: 0,
    projectileCount: 3, spread: 0, range: 0, windup: 0.4, duration: 0.5, weight: 2
  })
});

export function bossTuningSchema(number, toggle) {
  return BOSS_PHASES.flatMap((phase) => {
    const phaseDefaults = PHASE_DEFAULTS[phase];
    const category = `Boss Phase ${phase}`;
    const phaseFields = [
      ...(phase === 1 ? [] : [
        number(`bossPhase${phase}HealthThreshold`, category, 'Health threshold', phaseDefaults.healthThreshold, 0.05, 1, .01, 'Health fraction where this phase begins. Phase 2 must stay above Phase 3.')
      ]),
      number(`bossPhase${phase}AttackSpeedMultiplier`, category, 'Attack-speed multiplier', phaseDefaults.attackSpeedMultiplier, .1, 5, .05, 'Scales how quickly the phase may choose its next attack.'),
      number(`bossPhase${phase}DamageMultiplier`, category, 'Damage multiplier', phaseDefaults.damageMultiplier, 0, 5, .05, 'Scales all Guardian damage in this phase.'),
      number(`bossPhase${phase}GlobalCooldown`, category, 'Global attack cooldown', phaseDefaults.globalCooldown, .15, 12, .05, 'Minimum pause after any Guardian attack.'),
      number(`bossPhase${phase}RepeatCooldown`, category, 'Same-attack repeat cooldown', phaseDefaults.repeatCooldown, 0, 20, .1, 'Extra fairness interval before the same attack may be selected again.'),
      number(`bossPhase${phase}MovementSpeed`, category, 'Movement speed multiplier', phaseDefaults.movementSpeed, .1, 4, .05, 'Guardian chase speed during this phase.'),
      number(`bossPhase${phase}ChasePressure`, category, 'Chase pressure', phaseDefaults.chasePressure, .5, 15, .1, 'How quickly the Guardian corrects its movement toward the miner.'),
      number(`bossPhase${phase}ReinforcementCooldown`, category, 'Reinforcement gate cooldown', phaseDefaults.summonCooldown, .5, 60, .25, 'Phase-wide minimum interval between successful reinforcement calls. This is separate from the Summon attack cooldown.'),
      number(`bossPhase${phase}MaxSummons`, category, 'Maximum active summons', phaseDefaults.maxSummons, 0, 30, 1, 'Hard cap for reinforcements owned by one Guardian.')
    ];
    const attackFields = BOSS_ATTACKS.flatMap((attack) => {
      const defaults = phaseAttackDefaults(phase, attack);
      const prefix = `bossPhase${phase}${capitalize(attack)}`;
      const attackCategory = `Boss Phase ${phase} · ${capitalize(attack)}`;
      const shared = [
        toggle(`${prefix}Enabled`, attackCategory, 'Enabled', defaults.enabled, `Allows ${attack} to enter the deterministic phase scheduler.`),
        number(`${prefix}Cooldown`, attackCategory, 'Individual cooldown', defaults.cooldown, .1, 60, .05, `Minimum interval between ${attack} uses by the same Guardian.`),
        number(`${prefix}Windup`, attackCategory, 'Warning / wind-up seconds', defaults.windup, 0, 4, .05, 'Readable delay recorded for presentation and scheduler timing.'),
        number(`${prefix}Duration`, attackCategory, 'Attack duration seconds', defaults.duration, .05, 8, .05, 'Time reserved by the attack before another action can begin.'),
        number(`${prefix}Weight`, attackCategory, 'Selection weight', defaults.weight, 0, 100, .1, 'Relative deterministic selection frequency when the attack is ready.')
      ];
      const damaging = attack === 'summon' ? [] : [
        number(`${prefix}Damage`, attackCategory, 'Damage multiplier', defaults.damage, 0, 5, .01, 'Multiplier applied to the Guardian base damage.')
      ];
      const projectile = attack === 'volley' || attack === 'radial' ? [
        number(`${prefix}ProjectileSpeed`, attackCategory, 'Projectile speed', defaults.projectileSpeed, 0, 1800, 10),
        number(`${prefix}ProjectileCount`, attackCategory, 'Projectile count', defaults.projectileCount, 0, 30, 1),
        ...(attack === 'volley' ? [
          number(`${prefix}Spread`, attackCategory, 'Spread radians', defaults.spread, 0, 6.2832, .01)
        ] : []),
        number(`${prefix}Range`, attackCategory, 'Projectile range', defaults.range, 0, 1400, 10)
      ] : [];
      const slam = attack === 'slam' ? [
        number(`${prefix}Range`, attackCategory, 'Slam radius', defaults.range, 0, 1400, 10)
      ] : [];
      const summon = attack === 'summon' ? [
        number(`${prefix}ProjectileCount`, attackCategory, 'Requested reinforcements', defaults.projectileCount, 0, 30, 1, 'Limited by the phase maximum-active-summons control.')
      ] : [];
      return [...shared, ...damaging, ...projectile, ...slam, ...summon];
    });
    return [...phaseFields, ...attackFields];
  });
}

export function bossPhaseForTuning(hp, maxHp, tuning = {}) {
  const ratio = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
  const phase2 = Number(tuning.bossPhase2HealthThreshold ?? PHASE_DEFAULTS[2].healthThreshold);
  const phase3 = Math.min(phase2, Number(tuning.bossPhase3HealthThreshold ?? PHASE_DEFAULTS[3].healthThreshold));
  if (ratio <= phase3) return 3;
  if (ratio <= phase2) return 2;
  return 1;
}

export function bossPhaseConfig(tuning = {}, phase = 1) {
  const defaults = PHASE_DEFAULTS[phase] || PHASE_DEFAULTS[1];
  const prefix = `bossPhase${phase}`;
  return {
    healthThreshold: Number(tuning[`${prefix}HealthThreshold`] ?? defaults.healthThreshold),
    attackSpeedMultiplier: Number(tuning[`${prefix}AttackSpeedMultiplier`] ?? defaults.attackSpeedMultiplier),
    damageMultiplier: Number(tuning[`${prefix}DamageMultiplier`] ?? defaults.damageMultiplier),
    globalCooldown: Number(tuning[`${prefix}GlobalCooldown`] ?? defaults.globalCooldown),
    repeatCooldown: Number(tuning[`${prefix}RepeatCooldown`] ?? defaults.repeatCooldown),
    movementSpeed: Number(tuning[`${prefix}MovementSpeed`] ?? defaults.movementSpeed),
    chasePressure: Number(tuning[`${prefix}ChasePressure`] ?? defaults.chasePressure),
    summonCooldown: Number(tuning[`${prefix}ReinforcementCooldown`] ?? defaults.summonCooldown),
    maxSummons: Math.max(0, Math.round(Number(tuning[`${prefix}MaxSummons`] ?? defaults.maxSummons)))
  };
}

export function bossAttackConfig(tuning = {}, phase = 1, attack = 'slam') {
  const defaults = phaseAttackDefaults(phase, attack);
  const prefix = `bossPhase${phase}${capitalize(attack)}`;
  return {
    id: attack,
    enabled: tuning[`${prefix}Enabled`] ?? defaults.enabled,
    cooldown: Number(tuning[`${prefix}Cooldown`] ?? defaults.cooldown),
    damage: Number(tuning[`${prefix}Damage`] ?? defaults.damage),
    projectileSpeed: Number(tuning[`${prefix}ProjectileSpeed`] ?? defaults.projectileSpeed),
    projectileCount: Math.max(0, Math.round(Number(tuning[`${prefix}ProjectileCount`] ?? defaults.projectileCount))),
    spread: Number(tuning[`${prefix}Spread`] ?? defaults.spread),
    range: Number(tuning[`${prefix}Range`] ?? defaults.range),
    windup: Number(tuning[`${prefix}Windup`] ?? defaults.windup),
    duration: Number(tuning[`${prefix}Duration`] ?? defaults.duration),
    weight: Number(tuning[`${prefix}Weight`] ?? defaults.weight)
  };
}

export function selectBossAttack(enemy, tuning, phase, elapsed, activeSummons = 0) {
  const scheduler = ensureBossScheduler(enemy);
  const phaseConfig = bossPhaseConfig(tuning, phase);
  if (elapsed < scheduler.globalReadyAt) return null;
  const eligible = BOSS_ATTACKS.map((attack) => bossAttackConfig(tuning, phase, attack))
    .filter((attack) => attack.enabled && attack.weight > 0)
    .filter((attack) => elapsed >= Number(scheduler.readyAt[attack.id] || 0))
    .filter((attack) => attack.id !== scheduler.lastAttack || elapsed >= scheduler.lastAttackAt + phaseConfig.repeatCooldown)
    .filter((attack) => attack.id !== 'summon' || (
      activeSummons < phaseConfig.maxSummons &&
      elapsed >= scheduler.summonReadyAt
    ));
  if (!eligible.length) return null;
  const total = eligible.reduce((sum, attack) => sum + attack.weight, 0);
  let roll = deterministicBossRoll(enemy, scheduler.sequence) * total;
  let selected = eligible.at(-1);
  for (const attack of eligible) {
    roll -= attack.weight;
    if (roll <= 0) {
      selected = attack;
      break;
    }
  }
  scheduler.sequence += 1;
  scheduler.lastAttack = selected.id;
  scheduler.lastAttackAt = elapsed;
  scheduler.globalReadyAt = elapsed + Math.max(
    phaseConfig.globalCooldown / Math.max(.1, phaseConfig.attackSpeedMultiplier),
    selected.windup + selected.duration
  );
  scheduler.readyAt[selected.id] = elapsed + selected.cooldown;
  if (selected.id === 'summon') scheduler.summonReadyAt = elapsed + phaseConfig.summonCooldown;
  return selected;
}

export function ensureBossScheduler(enemy) {
  enemy.bossScheduler ||= {
    sequence: 0,
    globalReadyAt: 0,
    summonReadyAt: 0,
    lastAttack: '',
    lastAttackAt: -Infinity,
    readyAt: Object.fromEntries(BOSS_ATTACKS.map((attack) => [attack, 0]))
  };
  return enemy.bossScheduler;
}

export function validateBossThresholds(tuning) {
  const phase2 = Number(tuning.bossPhase2HealthThreshold);
  const phase3 = Number(tuning.bossPhase3HealthThreshold);
  if (Number.isFinite(phase2) && Number.isFinite(phase3) && phase3 >= phase2) {
    throw new Error('Boss Phase 3 health threshold must be lower than Phase 2.');
  }
  return tuning;
}

function phaseAttackDefaults(phase, attack) {
  const base = { ...ATTACK_DEFAULTS[attack] };
  if (phase === 1) {
    if (attack === 'radial' || attack === 'summon') base.enabled = false;
    if (attack === 'volley') base.projectileCount = 3;
  }
  if (phase === 2) {
    if (attack === 'radial') base.weight = 1;
    if (attack === 'summon') base.projectileCount = 3;
  }
  if (phase === 3) {
    if (attack === 'slam') base.range = 235;
    if (attack === 'volley') {
      base.projectileCount = 7;
      base.spread = 1.8;
    }
    if (attack === 'summon') base.projectileCount = 2;
  }
  return base;
}

function deterministicBossRoll(enemy, sequence) {
  let value = ((Number(enemy.id) || 1) * 2654435761 + (sequence + 1) * 1013904223) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967296;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
