import { getAddress } from 'viem';
import { MAX_RUN_SCORE } from './constants.js';
import { ApiError, assertApi } from './errors.js';
import { validateUsername } from './identity.js';
import { MattMineService } from './service.js';
import { utcDayKey, utcWeekKey } from '../src/game/economy.js';
import { META_UPGRADES } from '../src/game/config.js';
import { defaultKeybindings, normalizeKeybindings } from '../src/game/keybindings.js';
import {
  COSMETIC_SLOTS,
  PASS_CHEST_ID,
  PASS_COSMETICS,
  PASS_REWARD_LEVELS,
  defaultPassInventory
} from '../src/game/passRewards.js';
import { defaultProfile } from '../src/game/storage.js';
import {
  NUGGET_LEDGER_TYPES,
  setNuggetLedgerBalance
} from './nugget-ledger.js';

const MAX_PLAYER_VALUE = 1_000_000_000;

export class AdminMattMineService extends MattMineService {
  async adminWallet(adminKey, address) {
    const detail = await super.adminWallet(adminKey, address);
    const normalizedAddress = normalizeAddress(address);
    const state = await this.database.read();
    const wallet = state.wallets[normalizedAddress];
    const arenaActiveRun = await Promise.resolve(this.arenaService?.adminActiveRuns?.(normalizedAddress))
      .then((runs) => runs[0] || null)
      .catch(() => null);
    return {
      ...detail,
      wallet: {
        ...detail.wallet,
        activeRuns: detail.wallet.activeRuns + (arenaActiveRun ? 1 : 0),
        arenaActiveRun: arenaActiveRun ? {
          runId: arenaActiveRun.runId,
          day: arenaActiveRun.day,
          startedAt: arenaActiveRun.startedAt,
          expiresAt: arenaActiveRun.expiresAt
        } : null,
        keybindings: structuredClone(wallet?.keybindings || defaultKeybindings()),
        leaderboardScores: currentRankedScores(state, normalizedAddress, this.now())
      },
      editor: playerEditorMetadata()
    };
  }

  async adminAwardPlayer(adminKey, address, input, reason) {
    if (String(input?.type || '') === 'score_override') {
      return this.adminOverrideLeaderboardScore(adminKey, address, input, reason);
    }
    if (String(input?.type || '') !== 'state_patch') {
      return super.adminAwardPlayer(adminKey, address, input, reason);
    }
    return this.adminUpdatePlayerState(adminKey, address, input.patch, reason);
  }

  async adminUpdatePlayerState(adminKey, address, input, reason) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    const normalizedReason = normalizeAdminReason(reason);
    assertApi(isRecord(input), 400, 'player_state_patch_invalid', 'Player state changes must be an object.');
    const timestamp = this.now();
    const terminateActiveRuns = input.terminateActiveRuns === true;
    const arenaActiveRuns = await Promise.resolve(this.arenaService?.adminActiveRuns?.(normalizedAddress)).catch(() => []) || [];
    assertApi(
      terminateActiveRuns || arenaActiveRuns.length === 0,
      409,
      'player_state_active_run',
      'Choose “End active runs and apply now” before editing a player who is in MATT Arena.'
    );

    const result = await this.database.transact(async (state, transaction) => {
      const wallet = state.wallets[normalizedAddress];
      assertApi(wallet, 404, 'wallet_missing', 'The player wallet was not found.');
      const activeRuns = Object.values(state.runs).filter((run) =>
        run.address === normalizedAddress &&
        run.status === 'active' &&
        run.expiresAt > timestamp
      );
      assertApi(
        terminateActiveRuns || activeRuns.length === 0,
        409,
        'player_state_active_run',
        'Choose “End active runs and apply now” before editing this player.'
      );
      const terminatedRunIds = [];
      if (terminateActiveRuns) {
        for (const run of activeRuns) {
          run.status = 'expired';
          run.expiresAt = Math.min(run.expiresAt, timestamp);
          run.adminTerminatedAt = timestamp;
          run.adminTerminationReason = normalizedReason;
          await transaction?.upsertRun(run);
          terminatedRunIds.push(run.id || run.runId);
        }
      }

      const changes = [];
      applyResets(wallet, input.reset, changes);
      applyIdentity(state, wallet, input.identity, normalizedAddress, timestamp, changes);
      applyProfile(wallet, input.profile, changes);
      applyPass(wallet, input.pass, timestamp, changes);
      applyDaily(wallet, input.daily, timestamp, changes);
      applyKeybindings(wallet, input.keybindings, changes);

      assertApi(changes.length > 0, 400, 'player_state_patch_empty', 'Change or reset at least one player field.');
      wallet.updatedAt = timestamp;
      const terminationDetails = terminatedRunIds.length
        ? `; ended ${terminatedRunIds.length} active run${terminatedRunIds.length === 1 ? '' : 's'}`
        : '';
      const details = `${normalizedReason}; ${normalizedAddress}: ${changes.join(', ')}${terminationDetails}`.slice(0, 500);
      addPlayerActivity(wallet, 'ADMIN_STATE_EDIT', details, timestamp);
      addAudit(state, 'SERVER_ADMIN', 'PLAYER_STATE_EDITED', details, timestamp);
      return { terminatedRunIds };
    });

    let arenaTerminated = { affected: 0, runIds: [] };
    if (terminateActiveRuns && arenaActiveRuns.length) {
      arenaTerminated = await this.arenaService.adminExpireActiveRuns(normalizedAddress);
    }
    for (const runId of [...result.terminatedRunIds, ...arenaTerminated.runIds]) {
      await this.competitiveReplayValidator?.finalize?.(runId, 'admin_terminated').catch(() => undefined);
    }
    const detail = await this.adminWallet(adminKey, normalizedAddress);
    return {
      ...detail,
      terminatedActiveRuns: result.terminatedRunIds.length + arenaTerminated.affected,
      terminatedRunIds: [...result.terminatedRunIds, ...arenaTerminated.runIds]
    };
  }

  async adminOverrideLeaderboardScore(adminKey, address, input, reason) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    const normalizedReason = normalizeAdminReason(reason);
    const mode = String(input?.mode || '');
    assertApi(['free', 'paid'].includes(mode), 422, 'score_override_mode_invalid', 'Choose Daily Mine or Pass Mine.');
    const score = strictInteger(input?.score, 'leaderboard_score', 0, MAX_RUN_SCORE * 7);
    const timestamp = this.now();
    const week = utcWeekKey(timestamp);
    const requestedWeek = String(input?.week || week);
    assertApi(requestedWeek === week, 409, 'score_override_week_closed', 'Only the current open leaderboard can be corrected. Finalized weeks remain immutable.');
    const terminateActiveRuns = input?.terminateActiveRuns !== false;

    const result = await this.database.transact(async (state, transaction) => {
      const wallet = state.wallets[normalizedAddress];
      assertApi(wallet, 404, 'wallet_missing', 'The player wallet was not found.');
      const activeRuns = Object.values(state.runs).filter((run) =>
        run.address === normalizedAddress &&
        run.mode === mode &&
        run.status === 'active'
      );
      assertApi(
        terminateActiveRuns || activeRuns.length === 0,
        409,
        'score_override_active_run',
        'End the player’s active run for this mine before correcting the leaderboard.'
      );
      const previousScore = rankedScoreFor(state, normalizedAddress, mode, week);
      const terminatedRunIds = [];
      for (const run of terminateActiveRuns ? activeRuns : []) {
        run.status = 'expired';
        run.expiresAt = Math.min(run.expiresAt, timestamp);
        run.finishedAt = timestamp;
        run.adminTerminatedAt = timestamp;
        run.adminTerminationReason = normalizedReason;
        await transaction?.upsertRun(run);
        terminatedRunIds.push(run.id || run.runId);
      }
      const key = `${week}:${mode}:${normalizedAddress}`;
      state.leaderboardOverrides[key] = {
        address: normalizedAddress,
        mode,
        week,
        score,
        reason: normalizedReason,
        updatedAt: timestamp,
        updatedBy: 'SERVER_ADMIN'
      };
      const mine = mode === 'free' ? 'Daily Mine' : 'Pass Mine';
      const details = `${normalizedReason}; ${normalizedAddress}: ${mine} ${week} score ${previousScore} -> ${score}; ended ${terminatedRunIds.length} active run${terminatedRunIds.length === 1 ? '' : 's'}`;
      addPlayerActivity(wallet, 'ADMIN_LEADERBOARD_SCORE_OVERRIDE', details, timestamp);
      addAudit(state, 'SERVER_ADMIN', 'PLAYER_LEADERBOARD_SCORE_OVERRIDDEN', details, timestamp);
      return { previousScore, score, mode, week, terminatedRunIds };
    });

    for (const runId of result.terminatedRunIds) {
      await this.competitiveReplayValidator?.finalize?.(runId, 'admin_score_override').catch(() => undefined);
    }
    const detail = await this.adminWallet(adminKey, normalizedAddress);
    return {
      ...detail,
      scoreCorrection: result,
      terminatedActiveRuns: result.terminatedRunIds.length,
      terminatedRunIds: result.terminatedRunIds
    };
  }
}

function currentRankedScores(state, address, timestamp) {
  const week = utcWeekKey(timestamp);
  return {
    week,
    free: rankedScoreFor(state, address, 'free', week),
    paid: rankedScoreFor(state, address, 'paid', week)
  };
}

function rankedScoreFor(state, address, mode, week) {
  const override = state.leaderboardOverrides?.[`${week}:${mode}:${address}`];
  if (override && Number.isSafeInteger(override.score)) return override.score;
  const dailyBest = new Map();
  for (const run of Object.values(state.runs || {})) {
    if (
      run.address !== address ||
      run.mode !== mode ||
      run.week !== week ||
      run.status !== 'finished' ||
      !run.result
    ) continue;
    dailyBest.set(run.day, Math.max(dailyBest.get(run.day) || 0, Number(run.result.score || 0)));
  }
  return [...dailyBest.values()].reduce((sum, value) => sum + value, 0);
}

function applyResets(wallet, input, changes) {
  if (!isRecord(input)) return;
  if (input.allProgress === true) {
    resetWalletProfile(wallet, { profileOnly: false });
    wallet.passProgress = { xp: 0, updatedAt: 0 };
    wallet.passInventory = defaultPassInventory();
    wallet.keybindings = defaultKeybindings();
    wallet.daily = {};
    changes.push('reset all mutable off-chain progression');
    return;
  }
  if (input.profile === true) {
    resetWalletProfile(wallet, { profileOnly: true });
    changes.push('reset gameplay profile and nuggets');
  }
  if (input.upgrades === true) {
    wallet.profile.meta = defaultProfile().meta;
    changes.push('reset permanent upgrades');
  }
  if (input.pass === true) {
    wallet.passProgress = { xp: 0, updatedAt: 0 };
    wallet.passInventory = defaultPassInventory();
    changes.push('reset Pass XP, achievements, chests, and cosmetics');
  }
  if (input.achievements === true) {
    wallet.passInventory.claimedLevels = [];
    changes.push('cleared Pass achievements');
  }
  if (input.cosmetics === true) {
    wallet.passInventory.cosmetics = [];
    wallet.passInventory.equipped = Object.fromEntries(COSMETIC_SLOTS.map((slot) => [slot, '']));
    changes.push('removed owned and equipped cosmetics');
  }
  if (input.keybindings === true) {
    wallet.keybindings = defaultKeybindings();
    changes.push('reset controls');
  }
  if (input.daily === true) {
    wallet.daily = {};
    changes.push('cleared daily-use state');
  }
}

function applyIdentity(state, wallet, input, address, timestamp, changes) {
  if (!isRecord(input)) return;
  if (Object.hasOwn(input, 'name')) {
    const requested = typeof input.name === 'string' ? input.name.trim() : '';
    if (!requested) {
      wallet.identity.name = '';
      wallet.identity.nameKey = '';
      wallet.identity.createdAt = 0;
      changes.push('cleared miner name');
    } else {
      const username = validateUsername(requested);
      const duplicate = Object.values(state.wallets).find((candidate) =>
        candidate.address !== address && candidate.identity?.nameKey === username.key
      );
      assertApi(!duplicate, 409, 'username_taken', 'That miner name is already used by another wallet.');
      wallet.identity.name = username.name;
      wallet.identity.nameKey = username.key;
      wallet.identity.createdAt ||= timestamp;
      changes.push(`set miner name ${username.name}`);
    }
  }
  if (input.clearAvatar === true) {
    wallet.identity.avatarDataUrl = '';
    wallet.identity.avatarUpdatedAt = timestamp;
    changes.push('removed profile picture');
  }
}

function applyProfile(wallet, input, changes) {
  if (!isRecord(input)) return;
  setInteger(input, 'bankedNuggets', 0, MAX_PLAYER_VALUE, (value) => {
    const target = Math.min(value, MAX_PLAYER_VALUE);
    const ledger = setNuggetLedgerBalance(wallet, target, {
      type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
      details: `Admin profile banked nuggets set to ${target}`,
      adminActor: 'SERVER_ADMIN',
      idempotencyKey: `admin-profile-balance:${wallet.address}:${target}`
    });
    wallet.profile.bankedNuggets = target;
    changes.push(`banked nuggets=${value}`);
  });
  setInteger(input, 'bestDepth', 0, 100, (value) => {
    wallet.profile.bestDepth = value;
    changes.push(`best depth=${value}`);
  });
  setInteger(input, 'bestScore', 0, MAX_RUN_SCORE, (value) => {
    wallet.profile.bestScore = value;
    changes.push(`best score=${value}`);
  });
  setInteger(input, 'totalRuns', 0, MAX_PLAYER_VALUE, (value) => {
    wallet.profile.totalRuns = value;
    changes.push(`total runs=${value}`);
  });

  if (isRecord(input.meta)) {
    for (const upgrade of META_UPGRADES) {
      if (!Object.hasOwn(input.meta, upgrade.id)) continue;
      const rank = strictInteger(input.meta[upgrade.id], `meta_${upgrade.id}`, 0, upgrade.max);
      wallet.profile.meta[upgrade.id] = rank;
      changes.push(`${upgrade.id} rank=${rank}`);
    }
  }
}

function resetWalletProfile(wallet, options = {}) {
  const previousBalance = wallet.profile?.bankedNuggets || 0;
  const profile = defaultProfile();
  wallet.profile = {
    ...profile,
    meta: { ...profile.meta }
  };

  if (previousBalance > 0) {
    const cleared = setNuggetLedgerBalance(wallet, 0, {
      type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
      details: `Profile reset${options.profileOnly ? '' : ' with progression'}`,
      adminActor: 'SERVER_ADMIN',
      idempotencyKey: `admin-profile-reset:${wallet.address}:${previousBalance}:${options.profileOnly ? 'partial' : 'full'}`
    });
    if (cleared.entry) wallet.profile.bankedNuggets = cleared.newBalance;
  } else {
    wallet.profile.bankedNuggets = 0;
  }
}

function applyPass(wallet, input, timestamp, changes) {
  if (!isRecord(input)) return;
  setInteger(input, 'xp', 0, MAX_PLAYER_VALUE, (value) => {
    wallet.passProgress.xp = value;
    wallet.passProgress.updatedAt = timestamp;
    changes.push(`Pass XP=${value}`);
  });

  if (Object.hasOwn(input, 'claimedLevels')) {
    assertApi(Array.isArray(input.claimedLevels), 422, 'claimed_levels_invalid', 'Pass achievements must be an array.');
    wallet.passInventory.claimedLevels = [...new Set(input.claimedLevels.map((level) =>
      strictInteger(level, 'claimed_level', 1, PASS_REWARD_LEVELS.length)
    ))].sort((left, right) => left - right);
    changes.push(`Pass achievements=${wallet.passInventory.claimedLevels.join('|') || 'none'}`);
  }

  if (Object.hasOwn(input, 'cosmetics')) {
    assertApi(Array.isArray(input.cosmetics), 422, 'cosmetics_invalid', 'Owned cosmetics must be an array.');
    wallet.passInventory.cosmetics = [...new Set(input.cosmetics.map((id) => {
      const cosmeticId = String(id || '');
      assertApi(PASS_COSMETICS[cosmeticId], 422, 'cosmetic_unknown', `Unknown cosmetic: ${cosmeticId}`);
      return cosmeticId;
    }))];
    for (const slot of COSMETIC_SLOTS) {
      if (!wallet.passInventory.cosmetics.includes(wallet.passInventory.equipped[slot])) {
        wallet.passInventory.equipped[slot] = '';
      }
    }
    changes.push(`owned cosmetics=${wallet.passInventory.cosmetics.join('|') || 'none'}`);
  }

  if (isRecord(input.equipped)) {
    for (const slot of COSMETIC_SLOTS) {
      if (!Object.hasOwn(input.equipped, slot)) continue;
      const cosmeticId = String(input.equipped[slot] || '');
      if (cosmeticId) {
        const cosmetic = PASS_COSMETICS[cosmeticId];
        assertApi(cosmetic?.slot === slot, 422, 'cosmetic_slot_invalid', `${cosmeticId} cannot be equipped in ${slot}.`);
        assertApi(wallet.passInventory.cosmetics.includes(cosmeticId), 422, 'cosmetic_not_owned', `${cosmeticId} is not owned by this player.`);
      }
      wallet.passInventory.equipped[slot] = cosmeticId;
      changes.push(`${slot}=${cosmeticId || 'none'}`);
    }
  }

  const chest = wallet.passInventory.chests[PASS_CHEST_ID];
  setInteger(input, 'chestAvailable', 0, 100, (value) => {
    chest.available = value;
    changes.push(`available Pass chests=${value}`);
  });
  setInteger(input, 'chestOpened', 0, 100, (value) => {
    chest.opened = value;
    changes.push(`opened Pass chests=${value}`);
  });
  setInteger(input, 'chestLastOpenedAt', 0, Number.MAX_SAFE_INTEGER, (value) => {
    chest.lastOpenedAt = value;
    changes.push(`last chest timestamp=${value}`);
  });
}

function applyDaily(wallet, input, timestamp, changes) {
  if (!isRecord(input) || !Object.hasOwn(input, 'freeRunUsedToday')) return;
  assertApi(typeof input.freeRunUsedToday === 'boolean', 422, 'free_run_state_invalid', 'Free-run state must be true or false.');
  const day = utcDayKey(timestamp);
  if (input.freeRunUsedToday) {
    wallet.daily[day] = { freeRunUsed: true, freeRunId: 'admin-marked-used' };
    changes.push('marked today’s free run used');
  } else {
    delete wallet.daily[day];
    changes.push('restored today’s free run');
  }
}

function applyKeybindings(wallet, input, changes) {
  if (!isRecord(input)) return;
  try {
    wallet.keybindings = normalizeKeybindings(input);
  } catch (error) {
    throw new ApiError(422, 'invalid_keybindings', error.message);
  }
  changes.push('updated gameplay controls');
}

function playerEditorMetadata() {
  return {
    metaUpgrades: META_UPGRADES.map((upgrade) => ({
      id: upgrade.id,
      name: upgrade.name,
      max: upgrade.max,
      description: upgrade.description
    })),
    cosmetics: Object.values(PASS_COSMETICS).map((cosmetic) => ({
      id: cosmetic.id,
      slot: cosmetic.slot,
      name: cosmetic.name
    })),
    cosmeticSlots: [...COSMETIC_SLOTS],
    passRewards: PASS_REWARD_LEVELS.map((reward) => ({ ...reward })),
    chestId: PASS_CHEST_ID,
    limits: {
      bankedNuggets: MAX_PLAYER_VALUE,
      bestDepth: 100,
      bestScore: MAX_RUN_SCORE,
      weeklyScore: MAX_RUN_SCORE * 7,
      totalRuns: MAX_PLAYER_VALUE,
      passXp: MAX_PLAYER_VALUE
    }
  };
}

function setInteger(source, key, min, max, setter) {
  if (!Object.hasOwn(source, key)) return;
  setter(strictInteger(source[key], key, min, max));
}

function strictInteger(value, name, min, max) {
  const number = Number(value);
  assertApi(
    Number.isSafeInteger(number) && number >= min && number <= max,
    422,
    `invalid_${name}`,
    `${name} must be an integer from ${min} to ${max}.`
  );
  return number;
}

function normalizeAddress(value) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new ApiError(400, 'invalid_address', 'The Ronin wallet address is invalid.');
  }
}

function normalizeAdminReason(value) {
  assertApi(typeof value === 'string', 400, 'admin_reason_required', 'A written reason is required for this admin action.');
  const reason = value.trim();
  assertApi(reason.length >= 5 && reason.length <= 240, 400, 'admin_reason_invalid', 'Admin reason must be 5 to 240 characters.');
  return reason;
}

function addAudit(state, actor, action, details, timestamp) {
  state.audit.push({
    id: `${timestamp}-${state.audit.length + 1}`,
    actor,
    action,
    details,
    timestamp
  });
  state.audit = state.audit.slice(-2_000);
}

function addPlayerActivity(wallet, action, details, timestamp) {
  wallet.activity ||= [];
  wallet.activity.push({
    id: `${timestamp}-${wallet.activity.length + 1}`,
    action,
    details: String(details || '').slice(0, 500),
    timestamp
  });
  wallet.activity = wallet.activity.slice(-500);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
