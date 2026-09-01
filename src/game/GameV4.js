import { MattMineGame as V3MattMineGame } from './GameV3.js';
import {
  ARENA_FIXED_STEP_MS,
  ArenaControlInput,
  captureArenaControlState,
  encodeArenaControlState,
  normalizeArenaControlState
} from './arenaControls.js';
import { seededRandom, withRandomSource } from './utils.js';
import { generateEndlessPhase, normalizeEndlessConfig } from './endlessMine.js';
import { applyEndlessContinuation } from './endlessContinuation.js';
import { nftMinerAtlasSourcesForLevel } from './v3/nftMinerAnimation.js';

const DETERMINISTIC_SERVER_MODES = new Set(['arena', 'practice', 'free', 'paid', 'weekly', 'endless']);

/**
 * v0.4 adds deterministic ranked-run seeds and economy metadata while
 * preserving the v0.3 combat engine. Entitlements are consumed outside the
 * game by the economy adapter before startRun is called.
 */
export class MattMineGame extends V3MattMineGame {
  startRun(context = {}) {
    const competitionSnapshot = context.competitionSnapshot && typeof context.competitionSnapshot === 'object'
      ? structuredClone(context.competitionSnapshot)
      : context.tuning?._competitionSnapshot && typeof context.tuning._competitionSnapshot === 'object'
        ? structuredClone(context.tuning._competitionSnapshot)
        : null;
    const startingDepth = context.mode === 'endless'
      ? Math.max(1, Math.floor(Number(context.currentPhase) || 1))
      : context.mode === 'practice' && competitionSnapshot?.status === 'test'
        ? Math.max(1, Math.min(5, Math.floor(Number(context.startingDepth) || 1)))
        : 1;
    const runtimeTuning = context.tuning && typeof context.tuning === 'object'
      ? { ...context.tuning }
      : {};
    if (competitionSnapshot) {
      Object.assign(runtimeTuning, competitionSnapshot.monsterTuning || {});
      runtimeTuning.usePerDepthRoomSpawns = competitionSnapshot.enemyPlanMode === 'generated';
      // A published Studio version owns its creature plan. Lobby-wide type
      // switches must not silently remove objects that Admin placed; the
      // Studio's per-depth Enabled switches remain authoritative.
      Object.assign(runtimeTuning, {
        spawnSlimes: true,
        spawnBats: true,
        spawnCrawlers: true,
        spawnBeetles: true,
        spawnExploders: true,
        spawnRanged: true
      });
    }
    this.runContext = {
      mode: context.mode || 'practice',
      seed: context.seed || `MATT-PRACTICE-${Date.now()}`,
      day: context.day || '',
      week: context.week || '',
      rewardWeight: Number(context.rewardWeight || 0),
      characterId: context.characterId || 'matt',
      character: context.character && typeof context.character === 'object' ? { ...context.character } : {},
      weeklyStage: context.weeklyStage && typeof context.weeklyStage === 'object' ? { ...context.weeklyStage } : null,
      endlessSnapshot: context.endlessSnapshot && typeof context.endlessSnapshot === 'object' ? { ...context.endlessSnapshot } : null,
      endlessRunId: String(context.endlessRunId || context.runId || ''),
      endlessConfigVersion: Math.max(1, Math.floor(Number(context.endlessConfigVersion || 1))),
      endlessManifest: context.endlessManifest && typeof context.endlessManifest === 'object'
        ? structuredClone(context.endlessManifest)
        : null,
      competitionSnapshot,
      startingDepth,
      roundDurationMs: context.mode === 'arena'
        ? normalizeRoundDuration(context.roundDurationMs)
        : 0,
      allowPaidRevive: context.allowPaidRevive === true,
      reviveLimitPerRun: context.allowPaidRevive === true
        ? Math.max(
            1,
            Math.min(
              3,
              Math.floor(Number(
                context.reviveLimitPerRun ?? context.tuning?._paidRevive?.limitPerRun ?? 1
              ) || 1)
            )
          )
        : 0,
      reviveInvulnerabilitySeconds: Math.max(0, Number(context.reviveInvulnerabilitySeconds || 3)),
      nftRun: context.nftRun && typeof context.nftRun === 'object'
        ? structuredClone(context.nftRun)
        : null,
      tuning: runtimeTuning
    };
    if (!this.headless) {
      delete this.visualAssets.nftMiner;
      delete this.visualAssets.nftMinerAtlas;
      delete this.visualAssets.nftMinerDirectionalAtlases;
      const minerId = Number(this.runContext.nftRun?.minerId || 0);
      if (Number.isSafeInteger(minerId) && minerId > 0 && typeof globalThis.Image === 'function') {
        const fallbackImage = new globalThis.Image();
        fallbackImage.decoding = 'async';
        fallbackImage.src = `/api/nft/miners/${minerId}/sprite.png`;
        this.visualAssets.nftMiner = fallbackImage;

        const level = Number(
          this.runContext.nftRun?.profile?.traits?.level ??
          this.runContext.nftRun?.profile?.progression?.level ??
          1
        );
        const atlasSources = nftMinerAtlasSourcesForLevel(level);
        const directionalAtlases = Object.fromEntries(
          ['east', 'north', 'south'].map((direction) => {
            const image = new globalThis.Image();
            image.decoding = 'async';
            image.src = atlasSources[direction];
            return [direction, image];
          })
        );
        this.visualAssets.nftMinerDirectionalAtlases = directionalAtlases;
        this.visualAssets.nftMinerAtlas = directionalAtlases.east;
      }
    }
    this.baseRunTuning = structuredClone(this.runContext.tuning);
    this.arenaAccumulator = 0;
    this.arenaFinishRecorded = false;
    this.paidReviveCount = 0;
    this.arenaRandom = DETERMINISTIC_SERVER_MODES.has(this.runContext.mode)
      ? seededRandom(
          this.runContext.mode === 'arena'
            ? `${this.runContext.seed}:MATT-ARENA-RUNTIME-V2`
            : `${this.runContext.seed}:MATT-SERVER-RUNTIME-V3`
        )
      : null;
    super.startRun();
    if (this.runContext.mode === 'endless') {
      applyEndlessContinuation(this, context.endlessContinuation);
    }
  }

  generateDepth() {
    if (this.runContext?.mode === 'endless' && this.runContext.endlessSnapshot) {
      const depth = this.run?.depth || 1;
      this.arenaRandom = seededRandom(
        `${this.runContext.seed}:ENDLESS:PHASE:${depth}:RUNTIME-V1`
      );
      const config = normalizeEndlessConfig(this.runContext.endlessSnapshot.config || this.runContext.endlessSnapshot);
      const supplied = this.runContext.endlessManifest;
      const manifest = supplied?.phase === depth
        ? structuredClone(supplied)
        : generateEndlessPhase({
            runId: this.runContext.endlessRunId || this.runContext.seed,
            runSeed: this.runContext.seed,
            phase: depth,
            configVersion: this.runContext.endlessConfigVersion,
            config,
            minerProfile: this.runContext.nftRun?.profile || this.runContext.tuning?._nftRun?.profile
          });
      const tuning = structuredClone(this.baseRunTuning || this.runContext.tuning || {});
      tuning.enemyHealthMultiplier = (tuning.enemyHealthMultiplier || 1) * manifest.difficulty.statScale.health;
      tuning.enemyDamageMultiplier = (tuning.enemyDamageMultiplier || 1) * manifest.difficulty.statScale.damage;
      tuning.enemySpeedMultiplier = (tuning.enemySpeedMultiplier || 1) * manifest.difficulty.statScale.speed;
      // Historical manifests did not record an Endless-only Guardian scale.
      // Preserve those exact replays while all newly generated phases carry
      // their explicit, Admin-adjustable boss balance in the fingerprint.
      const guardianStatScale = manifest.difficulty.guardianStatScale || { health: 1, damage: 1 };
      tuning.bossHealthMultiplier = (tuning.bossHealthMultiplier || 1) * guardianStatScale.health;
      tuning.bossDamageMultiplier = (tuning.bossDamageMultiplier ?? 1) * guardianStatScale.damage;
      tuning.safeStartSeconds = manifest.rules.safeStartSeconds;
      tuning.usePerDepthRoomSpawns = false;
      tuning._endlessManifest = manifest;
      const dynamicSnapshot = {
        id: `${manifest.generatorVersion}:${manifest.fingerprint}`,
        slotId: 'endless',
        status: 'live',
        enemyPlanMode: 'authored',
        guardianAiMode: 'advanced',
        monsterTuning: {},
        map: manifest.map,
        depths: [{ depth: Math.min(depth, 5), map: manifest.map }],
        loadout: {
          characterId: 'matt', startingWeapon: 'pickaxe', availableWeapons: ['pickaxe', 'dynamite', 'blaster'],
          startingHealth: 100, startingDynamite: 0, blasterEnergy: 115, runUpgrades: true, maximumDrones: 4, paidRevive: false
        },
        rules: { safeStartSeconds: manifest.rules.safeStartSeconds }
      };
      this.runContext.competitionSnapshot = dynamicSnapshot;
      tuning._competitionSnapshot = dynamicSnapshot;
      this.runContext.tuning = tuning;
      this.run.endlessManifest = manifest;
      this.run.endlessRequiredRemaining = manifest.gate.requiredCount;
      this.run.endlessRequiredKilled = [];
      this.run.endlessCompletionCredited = false;
      this.run.endlessRules = structuredClone(manifest.difficulty);
    }
    const seed = `${this.runContext?.seed || 'MATT-RANDOM'}:DEPTH:${this.run?.depth || 1}`;
    const source = DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode)
      ? this.arenaRandom
      : seededRandom(seed);
    return withRandomSource(source, () => super.generateDepth());
  }

  update(dt) {
    if (!DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode)) return super.update(dt);
    if (this.state !== 'playing' || this.pendingUpgradeIds?.length) {
      // Ranked replays advance only while the mine is actively playing.
      // Banking browser-frame time behind an upgrade, depth choice, pause, or
      // revive screen causes a large catch-up burst and desynchronizes the
      // signed client transcript from the server replay.
      this.arenaAccumulator = 0;
      return;
    }
    // Manual Consumables are replayed as explicit commands, not held control
    // state. Consume the browser/mobile edge before swapping in the fixed-step
    // ArenaControlInput so keys 4/5 reach both the live game and server replay.
    const selectedConsumable = this.input?.consumeConsumable?.();
    if (selectedConsumable) this.useConsumable(selectedConsumable);
    this.arenaAccumulator += Math.max(0, Math.min(Number(dt) || 0, 0.25));
    const stepSeconds = ARENA_FIXED_STEP_MS / 1_000;
    while (this.arenaAccumulator + Number.EPSILON >= stepSeconds) {
      const control = captureArenaControlState(this.input, this);
      this.applyArenaControlStep(control, true);
      this.arenaAccumulator -= stepSeconds;
      if (this.state !== 'playing') {
        this.arenaAccumulator = 0;
        break;
      }
    }
  }

  applyArenaControlStep(control, record = false) {
    if (!DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) || this.state !== 'playing') return false;
    const normalized = normalizeArenaControlState(control);
    const tick = Math.round((this.run?.elapsed || 0) * 1_000);
    if (record) {
      this.hooks.onArenaInput?.({
        type: 'input',
        tick,
        ...encodeArenaControlState(normalized)
      });
    }
    const originalInput = this.input;
    this.input = new ArenaControlInput(normalized);
    try {
      withRandomSource(this.arenaRandom, () => super.update(ARENA_FIXED_STEP_MS / 1_000));
    } finally {
      this.input = originalInput;
    }
    if (
      record &&
      this.runContext?.mode === 'arena' &&
      this.runContext.roundDurationMs > 0 &&
      Math.round((this.run?.elapsed || 0) * 1_000) >= this.runContext.roundDurationMs &&
      !['ended', 'menu'].includes(this.state)
    ) {
      this.endArenaTimeLimit();
    }
    return true;
  }

  advanceArenaToTick(targetTick, control) {
    if (!Number.isSafeInteger(targetTick) || targetTick < 0 || targetTick % ARENA_FIXED_STEP_MS !== 0) {
      return false;
    }
    while (
      Math.round((this.run?.elapsed || 0) * 1_000) < targetTick &&
      this.state === 'playing'
    ) {
      this.applyArenaControlStep(control, false);
    }
    return Math.round((this.run?.elapsed || 0) * 1_000) === targetTick;
  }

  updateAim() {
    if (DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode)) {
      const angle = this.input?.arenaAimAngle?.(this);
      if (Number.isFinite(angle)) {
        this.player.angle = angle;
        return;
      }
    }
    const controllerAim = this.input?.aimVector?.();
    if (controllerAim && Math.hypot(controllerAim.x, controllerAim.y) > .05) {
      this.player.angle = Math.atan2(controllerAim.y, controllerAim.x);
      return;
    }
    return super.updateAim();
  }

  updateHud() {
    const original = this.hooks.onHud;
    const roundDurationMs = this.runContext?.mode === 'arena'
      ? this.runContext.roundDurationMs || 0
      : 0;
    const roundElapsedMs = Math.round((this.run?.elapsed || 0) * 1_000);
    this.hooks.onHud = (stats) => original?.({
      ...stats,
      runMode: this.runContext?.mode || 'practice',
      rewardWeight: this.runContext?.rewardWeight || 0,
      endless: this.runContext?.mode === 'endless' ? {
        phasePoints: this.run?.endlessManifest?.pointBudget || 0,
        requiredRemaining: this.run?.endlessRequiredRemaining || 0,
        difficulty: this.run?.endlessManifest?.difficulty || null,
        capability: this.run?.endlessManifest?.capability || null,
        danger: this.run?.endlessManifest?.danger || null,
        modifier: this.run?.endlessManifest?.difficulty?.modifier || '',
        milestone: this.run?.endlessManifest?.difficulty?.milestone === true
      } : null,
      roundDurationMs,
      roundRemainingMs: Math.max(0, roundDurationMs - roundElapsedMs)
    });
    try {
      return super.updateHud();
    } finally {
      this.hooks.onHud = original;
    }
  }

  chooseRunUpgrade(id) {
    const deterministic = DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode);
    if (
      deterministic &&
      this.state === 'levelup' &&
      this.pendingUpgradeIds?.includes(id)
    ) {
      this.recordArenaCommand('upgrade', id);
    }
    return deterministic
      ? withRandomSource(this.arenaRandom, () => super.chooseRunUpgrade(id))
      : super.chooseRunUpgrade(id);
  }

  descend() {
    if (
      DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) &&
      this.runContext?.mode !== 'endless' &&
      this.state === 'depthchoice'
    ) {
      const publishedDepths = this.runContext?.competitionSnapshot?.depths?.length;
      const maximumDepth = Number.isSafeInteger(publishedDepths)
        ? Math.max(1, Math.min(5, publishedDepths))
        : 5;
      if ((this.run?.depth || 0) >= maximumDepth) return this.extract();
      this.recordArenaCommand('descend');
    }
    if (this.runContext?.mode === 'endless' && this.state === 'depthchoice') {
      this.recordArenaCommand('descend');
      this.run.depth += 1;
      this.run.elapsed = 0;
      this.state = 'playing';
      this.generateDepth();
      this.hooks.onDepthStarted?.(this.run.depth);
      this.hooks.onToast?.(`Endless Depth ${this.run.depth}: x${this.depthMultiplier().toFixed(2)}`);
      return;
    }
    return super.descend();
  }

  depthMultiplier(depth = this.run?.depth || 1) {
    if (this.runContext?.mode === 'endless') return 1;
    return super.depthMultiplier(depth);
  }

  updatePortal() {
    const previousState = this.state;
    super.updatePortal();
    if (
      this.runContext?.mode === 'endless' && previousState === 'playing' &&
      this.state === 'depthchoice' && !this.run.endlessCompletionCredited
    ) {
      const points = Math.max(0, Math.floor(Number(this.run.endlessManifest?.pointLedger?.completion) || 0));
      this.run.rawScore += points;
      this.run.endlessCompletionCredited = true;
      this.hooks.onArenaEvent?.({
        type: 'phase_completed',
        tick: Math.round((this.run?.elapsed || 0) * 1_000),
        phase: this.run.depth,
        points,
        manifestFingerprint: this.run.endlessManifest?.fingerprint || ''
      });
    }
  }

  extract() {
    if (DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) && this.state === 'depthchoice') {
      this.recordArenaCommand('extract');
    }
    return super.extract();
  }

  useConsumable(id, options = {}) {
    const replayTolerant = options.replay === true;
    const replayBoundary = replayTolerant && ['levelup', 'depthchoice'].includes(this.state);
    if (
      (this.state !== 'playing' && !replayBoundary) ||
      !this.run?.consumables ||
      !this.player ||
      this.player.health <= 0
    ) return false;
    const remaining = this.run.consumables.remaining || {};
    if (Number(remaining[id] || 0) <= 0) return false;
    if (id === 'medic-pack') {
      if (this.player.health >= this.player.maxHealth && !replayTolerant) {
        this.hooks.onToast?.('MEDIC PACK READY AFTER HEALTH DAMAGE');
        return false;
      }
      remaining[id] = Math.max(0, Number(remaining[id] || 0) - 1);
      this.run.consumables.medicPacksUsed = Math.max(
        0,
        Number(this.run.consumables.medicPacksUsed || 0)
      ) + 1;
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 25);
      this.addFloater(this.player.x, this.player.y - 52, '+25 HEALTH · MEDIC PACK', '#73ffb2');
      this.hooks.onToast?.('MEDIC PACK ACTIVATED');
    } else if (id === 'mythical-force-field') {
      remaining[id] = Math.max(0, Number(remaining[id] || 0) - 1);
      this.run.consumables.forceFieldsUsed = Math.max(
        0,
        Number(this.run.consumables.forceFieldsUsed || 0)
      ) + 1;
      this.player.forceFieldRemaining = 3;
      this.hooks.onToast?.("MATT'S MYTHICAL FORCE FIELD · 3");
    } else {
      return false;
    }
    if (options.record !== false && DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode)) {
      this.recordArenaCommand('consumable', id);
    }
    this.hooks.onConsumableUsed?.({ id, remaining: Number(remaining[id] || 0) });
    return true;
  }

  recordArenaCommand(command, value = '') {
    this.hooks.onArenaInput?.({
      type: 'command',
      tick: Math.round((this.run?.elapsed || 0) * 1_000),
      command,
      ...(value ? { value } : {})
    });
  }

  endArenaTimeLimit(options = {}) {
    const roundDurationMs = normalizeRoundDuration(
      options.roundDurationMs ?? this.runContext?.roundDurationMs
    );
    const elapsedMs = Math.round((this.run?.elapsed || 0) * 1_000);
    if (
      this.runContext?.mode !== 'arena' ||
      !this.run ||
      !roundDurationMs ||
      elapsedMs !== roundDurationMs ||
      ['ended', 'menu'].includes(this.state)
    ) {
      return false;
    }
    if (options.record !== false) this.recordArenaCommand('time_limit');
    this.run.timeLimitReached = true;
    this.endRun(true);
    return this.state === 'ended';
  }

  applyPaidRevive(options = {}) {
    if (
      this.state !== 'awaitingrevive' ||
      !this.player ||
      this.paidReviveCount >= this.runContext.reviveLimitPerRun
    ) return false;
    if (options.record !== false) this.recordArenaCommand('revive');
    this.paidReviveCount += 1;
    this.player.health = this.player.maxHealth;
    this.player.invulnerable = this.runContext.reviveInvulnerabilitySeconds;
    this.player.vx = 0;
    this.player.vy = 0;
    const safeRoom = this.layout?.startRoom;
    if (safeRoom) {
      this.player.x = safeRoom.x;
      this.player.y = safeRoom.y;
    }
    this.state = 'playing';
    this.audio.startMusic?.();
    this.hooks.onPaidReviveApplied?.({
      health: this.player.health,
      maximumHealth: this.player.maxHealth,
      invulnerabilitySeconds: this.runContext.reviveInvulnerabilitySeconds
    });
    return true;
  }

  declinePaidRevive(options = {}) {
    if (this.state !== 'awaitingrevive') return false;
    if (options.record !== false) this.recordArenaCommand('decline');
    this.runContext.allowPaidRevive = false;
    return this.endRun(false);
  }

  endRun(extracted) {
    if (
      extracted === false &&
      this.runContext?.allowPaidRevive &&
      this.paidReviveCount < this.runContext.reviveLimitPerRun &&
      this.state !== 'awaitingrevive'
    ) {
      this.player.health = 0;
      this.state = 'awaitingrevive';
      this.camera.shake = 0;
      this.audio.stopBoss?.();
      this.audio.stopMusic?.();
      this.recordArenaCommand('death');
      this.hooks.onPaidReviveOffered?.({
        projected: this.projectedPayout(),
        depth: this.run.depth,
        kills: this.run.kills,
        oreBroken: this.run.oreBroken,
        elapsed: this.run.elapsed,
        maximumHealth: this.player.maxHealth
      });
      return;
    }
    if (DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) && !this.arenaFinishRecorded) {
      this.arenaFinishRecorded = true;
      this.hooks.onArenaInput?.({
        type: 'finish',
        tick: Math.round((this.run?.elapsed || 0) * 1_000)
      });
    }
    const original = this.hooks.onRunEnd;
    this.hooks.onRunEnd = (result) => original?.({
      ...result,
      mode: this.runContext?.mode || 'practice',
      seed: this.runContext?.seed || '',
      day: this.runContext?.day || '',
      week: this.runContext?.week || '',
      rewardWeight: this.runContext?.rewardWeight || 0,
      endlessManifest: this.run?.endlessManifest ? structuredClone(this.run.endlessManifest) : null,
      endlessRequiredKilled: Array.isArray(this.run?.endlessRequiredKilled) ? [...this.run.endlessRequiredKilled] : [],
      timeLimitReached: this.run?.timeLimitReached === true
    });
    try {
      return super.endRun(extracted);
    } finally {
      this.hooks.onRunEnd = original;
    }
  }
}

function normalizeRoundDuration(value) {
  const duration = Number(value);
  return Number.isSafeInteger(duration) &&
    duration > 0 &&
    duration % ARENA_FIXED_STEP_MS === 0
    ? duration
    : 0;
}
