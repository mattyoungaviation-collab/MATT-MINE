import {
  BLASTER_RUN_UPGRADES,
  CONFIG,
  RUN_UPGRADES
} from '../config.js';
import { pickUnique } from '../utils.js';
import { stateMethods } from './state.js';
import { nftGameplayTraits } from '../nftTraits.js';

const LEGACY_META_SCALE = Object.freeze({
  health: 8,
  damage: .05,
  speed: .02,
  luck: .01,
  magnet: 6,
  dash: .02
});

export const balanceControlMethods = {
  startRun() {
    const tuning = this.runContext?.tuning || {};
    const browserProfile = this.profile;
    const runProfile = tuning._playerProfile && typeof tuning._playerProfile === 'object'
      ? tuning._playerProfile
      : browserProfile;
    const originalMeta = runProfile?.meta || {};
    const nftTraits = nftGameplayTraits(this.runContext);
    const ignorePermanent = tuning.ignorePermanentUpgrades === true || Boolean(nftTraits);
    const meta = ignorePermanent
      ? zeroMeta(originalMeta)
      : effectiveMeta(originalMeta, tuning);

    // Keep the server-pinned effective ranks for every depth. The profile is
    // restored after startup so gameplay must not fall back to the unscaled
    // browser profile when a later authored depth is generated.
    this.effectivePermanentMeta = meta;
    this.profile = { ...runProfile, meta };
    try {
      stateMethods.startRun.call(this);
    } finally {
      this.profile = browserProfile;
    }

    const permanentArmor = ignorePermanent
      ? 0
      : Number(originalMeta.armor || 0) * (tuning.permanentArmorPerRank ?? .008);
    this.player.armor = nftTraits
      ? 0
      : Math.min(
          tuning.armorMaximum ?? .45,
          Math.max(0, permanentArmor + Number(this.runContext?.character?.armor || 0))
        );

    const permanentBlaster = ignorePermanent
      ? 0
      : Number(originalMeta.blaster || 0) * (tuning.permanentBlasterDamagePerRank ?? .03);
    this.player.blasterDamageScale =
      (tuning.blasterDamageMultiplier ?? CONFIG.blasterDamageScale) *
      (1 + Math.max(0, permanentBlaster)) *
      Number(nftTraits ? 1 : this.runContext?.character?.blasterDamage || 1);
  },

  gainXp(amount) {
    const multiplier = Math.max(0, Number(this.runContext?.tuning?.xpMultiplier ?? 1));
    this.player.xp += Math.round(Math.max(0, Number(amount) || 0) * multiplier);
    if (this.player.xp < this.player.nextXp) return;

    this.player.xp -= this.player.nextXp;
    this.player.level += 1;
    this.player.nextXp = Math.round(this.player.nextXp * 1.28 + 12);
    this.run.runLevelUps += 1;

    const tuning = this.runContext?.tuning || {};
    if (tuning.disableRunUpgrades === true) {
      this.state = 'playing';
      this.pendingUpgradeIds = [];
      this.hooks.onToast?.(`Level ${this.player.level} reached — upgrades disabled for beta testing`);
      return;
    }

    this.state = 'levelup';
    const available = this.availableRunUpgrades(RUN_UPGRADES);
    if (!available.length) {
      this.pendingUpgradeIds = [];
      this.state = 'playing';
      this.hooks.onToast?.('Run build fully upgraded');
      return;
    }
    const offered = pickUnique(available, Math.min(3, available.length));
    this.pendingUpgradeIds = offered.map((upgrade) => upgrade.id);
    this.hooks.onLevelUp?.(offered.map((upgrade) => describeUpgrade(upgrade, tuning)));
  },

  chooseRunUpgrade(id) {
    const tuning = this.runContext?.tuning || {};
    const upgrade = [...RUN_UPGRADES, ...BLASTER_RUN_UPGRADES].find((entry) => entry.id === id);
    if (
      tuning.disableRunUpgrades === true ||
      (id === 'armor' && Boolean(nftGameplayTraits(this.runContext))) ||
      !upgrade ||
      this.state !== 'levelup' ||
      !Array.isArray(this.pendingUpgradeIds) ||
      !this.pendingUpgradeIds.includes(id)
    ) return;

    if (id === 'power') this.player.damage *= 1 + (tuning.runPowerPerLevel ?? .25);
    if (id === 'speed') this.player.speed *= 1 + (tuning.runSpeedPerLevel ?? .12);
    if (id === 'health') {
      const amount = tuning.runHealthPerLevel ?? 25;
      this.player.maxHealth += amount;
      this.player.health = Math.min(this.player.maxHealth, this.player.health + amount);
    }
    if (id === 'haste') {
      this.player.attackCooldown *= Math.max(.05, 1 - (tuning.runHastePerLevel ?? .15));
    }
    if (id === 'range') this.player.attackRange *= 1 + (tuning.runRangePerLevel ?? .2);
    if (id === 'crit') this.player.critChance += tuning.runCritPerLevel ?? .08;
    if (id === 'magnet') this.player.magnetRange += tuning.runMagnetPerLevel ?? 45;
    if (id === 'armor') {
      this.player.armor = Math.min(
        tuning.armorMaximum ?? .45,
        this.player.armor + (tuning.armorUpgradePerLevel ?? .08)
      );
    }
    if (id === 'dash') {
      this.player.dashCooldownMax = Math.max(
        .2,
        this.player.dashCooldownMax * Math.max(.05, 1 - (tuning.runDashRechargePerLevel ?? .25))
      );
    }
    if (id === 'dynamite') {
      this.player.dynamiteEvery = this.player.dynamiteEvery
        ? Math.max(3, this.player.dynamiteEvery - 1)
        : 5;
    }
    if (id === 'drone') {
      const maximumDrones = Math.max(0, Math.min(4, Math.floor(tuning.maximumDrones ?? 4)));
      this.player.droneCount = Math.min(maximumDrones, this.player.droneCount + 1);
    }
    if (id === 'blastercap') {
      this.player.blasterEnergyMax += tuning.blasterCapacityPerLevel ?? 30;
      this.player.blasterEnergy = this.player.blasterEnergyMax;
    }
    if (id === 'blasterregen') {
      this.player.blasterEnergyRegen *= 1 + (tuning.blasterRechargePerLevel ?? .35);
    }
    if (id === 'blasterpower') {
      this.player.blasterDamageScale *= 1 + (tuning.blasterFocusedCoreBonus ?? .10);
    }
    if (id === 'blastervolley') {
      this.player.blasterVolley = Math.min(
        Math.max(1, Math.floor(tuning.blasterBeams ?? 3)),
        this.player.blasterVolley + 1
      );
    }

    this.player.runUpgradeCounts[id] = (this.player.runUpgradeCounts[id] || 0) + 1;
    this.pendingUpgradeIds = [];
    this.state = 'playing';
    this.hooks.onUpgradeChosen?.(describeUpgrade(upgrade, tuning));
    if (this.pendingBlasterUpgrade) {
      this.pendingBlasterUpgrade = false;
      this.offerBlasterUpgrade();
    }
  },

  offerBlasterUpgrade() {
    const tuning = this.runContext?.tuning || {};
    if (tuning.disableRunUpgrades === true || tuning.disableBlasterUpgrades === true) {
      this.pendingBlasterUpgrade = false;
      this.player.blasterEnergy = this.player.blasterEnergyMax;
      this.hooks.onToast?.('Crystal Blaster refilled — cache upgrades disabled for beta testing');
      return;
    }
    if (this.state === 'levelup') {
      this.pendingBlasterUpgrade = true;
      return;
    }
    const available = this.availableRunUpgrades(BLASTER_RUN_UPGRADES);
    if (!available.length) {
      this.hooks.onToast?.('Crystal Blaster fully tuned');
      return;
    }
    const offered = pickUnique(available, Math.min(3, available.length));
    this.pendingUpgradeIds = offered.map((upgrade) => upgrade.id);
    this.state = 'levelup';
    this.hooks.onLevelUp?.(offered.map((upgrade) => describeUpgrade(upgrade, tuning)));
    this.hooks.onToast?.('Treasure cache opened — tune your Crystal Blaster');
  },

  availableRunUpgrades(pool) {
    const tuning = this.runContext?.tuning || {};
    const nftTraits = nftGameplayTraits(this.runContext);
    if (tuning.disableRunUpgrades === true) return [];
    if (pool === BLASTER_RUN_UPGRADES && tuning.disableBlasterUpgrades === true) return [];
    const counts = this.player?.runUpgradeCounts || {};
    const maximumBeams = Math.max(1, Math.floor(tuning.blasterBeams ?? 3));
    return pool.filter((upgrade) => {
      if ((counts[upgrade.id] || 0) >= (upgrade.max ?? Number.POSITIVE_INFINITY)) return false;
      if (upgrade.id === 'armor' && nftTraits) return false;
      if (upgrade.id === 'armor' && this.player.armor >= (tuning.armorMaximum ?? .45) - Number.EPSILON) return false;
      if (upgrade.id === 'blastervolley' && this.player.blasterVolley >= maximumBeams) return false;
      return true;
    });
  }
};

function effectiveMeta(meta, tuning) {
  return {
    ...meta,
    health: scaledRank(meta.health, tuning.permanentHealthPerRank ?? 8, LEGACY_META_SCALE.health),
    damage: scaledRank(meta.damage, tuning.permanentDamagePerRank ?? .05, LEGACY_META_SCALE.damage),
    speed: scaledRank(meta.speed, tuning.permanentSpeedPerRank ?? .02, LEGACY_META_SCALE.speed),
    luck: scaledRank(meta.luck, tuning.permanentLuckPerRank ?? .01, LEGACY_META_SCALE.luck),
    magnet: scaledRank(meta.magnet, tuning.permanentMagnetPerRank ?? 6, LEGACY_META_SCALE.magnet),
    dash: scaledRank(meta.dash, tuning.permanentDashPerRank ?? .02, LEGACY_META_SCALE.dash),
    armor: 0,
    blaster: 0
  };
}

function scaledRank(rank, desiredPerRank, legacyPerRank) {
  return Number(rank || 0) * Number(desiredPerRank || 0) / legacyPerRank;
}

function zeroMeta(meta) {
  return Object.fromEntries(Object.keys(meta || {}).map((id) => [id, 0]));
}

function describeUpgrade(upgrade, tuning) {
  const descriptions = {
    power: `+${percent(tuning.runPowerPerLevel ?? .25)} attack and mining damage`,
    speed: `+${percent(tuning.runSpeedPerLevel ?? .12)} movement speed`,
    health: `+${Math.round(tuning.runHealthPerLevel ?? 25)} max health and healing`,
    haste: `${percent(tuning.runHastePerLevel ?? .15)} faster attacks`,
    range: `+${percent(tuning.runRangePerLevel ?? .2)} attack range`,
    crit: `+${percent(tuning.runCritPerLevel ?? .08)} critical chance`,
    magnet: `+${Math.round(tuning.runMagnetPerLevel ?? 45)} pickup range`,
    armor: `Take ${percent(tuning.armorUpgradePerLevel ?? .08)} less damage, capped at ${percent(tuning.armorMaximum ?? .45)}`,
    dash: `Dash recharges ${percent(tuning.runDashRechargePerLevel ?? .25)} faster`,
    blastercap: `+${Math.round(tuning.blasterCapacityPerLevel ?? 30)} maximum Blaster energy and refill it`,
    blasterregen: `+${percent(tuning.blasterRechargePerLevel ?? .35)} Blaster recharge speed`,
    blasterpower: `+${percent(tuning.blasterFocusedCoreBonus ?? .10)} Blaster damage`,
    blastervolley: 'Add one beam; each projectile uses the configured split-damage multiplier'
  };
  return descriptions[upgrade.id]
    ? { ...upgrade, description: descriptions[upgrade.id] }
    : upgrade;
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}
