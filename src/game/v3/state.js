import { CONFIG, ORE_TYPES } from '../config.js';
import { createMineLayout, randomPointInRoom, roomAt } from '../layout.js';
import { clamp, random, randomRange, weightedChoice } from '../utils.js';
import { bossPhaseForHealth, roomRequiresLock } from '../combat.js';
import { nftGameplayTraits, nftHealAmount } from '../nftTraits.js';
import {
  MAP_OBJECT_KINDS,
  competitionMapForDepth,
  materializeCompetitionMap
} from '../competitionStudio.js';

export const stateMethods = {
  startRun() {
    this.runtimeError = null;
    this.entityId = 1;
    const isArena = this.runContext?.mode === 'arena';
    const meta = this.effectivePermanentMeta || this.profile.meta;
    const tuning = this.runContext?.tuning || {};
    const character = this.runContext?.character || {};
    const nftTraits = nftGameplayTraits(this.runContext);
    const characterHealthScale = nftTraits ? 1 : Number(character.baseHealth || 100) / 100;
    const nftHealth = nftTraits?.maximumHealth || (this.runContext?.nftRun
      ? Math.max(1, Number(tuning.playerMaxHealth || CONFIG.basePlayerHealth))
      : 0);
    const maxHealth = nftHealth ||
      ((tuning.playerMaxHealth || CONFIG.basePlayerHealth) + (meta.health || 0) * 8) * characterHealthScale;
    this.run = {
      depth: this.runContext?.startingDepth || 1,
      rawNuggets: 0,
      displayedScore: 0,
      kills: 0,
      oreBroken: 0,
      crystals: 0,
      crystalsCollected: 0,
      bossKilled: false,
      bossReady: false,
      bossSpawned: false,
      elapsed: 0,
      runLevelUps: 0,
      startedAt: Date.now(),
      attackCounter: 0,
      safeStartUntil: 0,
      bossTelemetry: {
        encounterStartedAt: 0,
        encounterEndedAt: 0,
        damageDealt: 0,
        damageReceived: 0,
        playerDeaths: 0,
        attacksUsed: {},
        bosses: {}
      }
    };
    this.player = {
      x: CONFIG.worldWidth / 2,
      y: CONFIG.worldHeight / 2,
      vx: 0,
      vy: 0,
      radius: tuning.playerRadius || CONFIG.playerRadius,
      maxHealth,
      health: maxHealth,
      maxShield: nftTraits?.armorShield || 0,
      shield: nftTraits?.armorShield || 0,
      speed: (tuning.playerSpeed || CONFIG.basePlayerSpeed) * (1 + (meta.speed || 0) * 0.02) * Number(nftTraits ? 1 : character.movementSpeed || 1),
      damage: nftTraits?.pickaxeAttack || ((tuning.playerBaseDamage || CONFIG.baseDamage) * (1 + (meta.damage || 0) * 0.05) * Number(character.pickaxeDamage || 1)),
      blasterBaseDamage: nftTraits?.blasterAttack || 0,
      dynamiteBaseDamage: nftTraits?.dynamiteAttack || 0,
      healAmount: nftTraits?.healAmount || 0,
      minerLevel: nftTraits?.level || 0,
      crystalCarryCapacity: nftTraits?.carryCapacity || 0,
      crystalDeathRetentionBps: nftTraits?.deathRetentionBps || 0,
      crystalsPerHour: nftTraits?.crystalsPerHour || 0,
      attackCooldown: (tuning.pickaxeCooldown || CONFIG.baseAttackCooldown) / Number(nftTraits ? 1 : character.miningSpeed || 1),
      attackTimer: 0,
      attackRange: tuning.pickaxeRange || CONFIG.baseAttackRange,
      critChance: tuning.playerCritChance ?? CONFIG.baseCritChance,
      magnetRange: ((tuning.playerMagnetRange || CONFIG.baseMagnetRange) + (meta.magnet || 0) * 6) * Number(nftTraits ? 1 : character.magnetRange || 1),
      armor: nftTraits ? 0 : Math.min(0.8, (meta.armor || 0) * 0.01 + Number(character.armor || 0)),
      level: 1,
      xp: 0,
      nextXp: 45,
      angle: 0,
      hitFlash: 0,
      invulnerable: 0,
      swingTimer: 0,
      dashCooldown: 0,
      dashCooldownMax: ((tuning.dashCooldown || CONFIG.baseDashCooldown) / (1 + (meta.dash || 0) * 0.02)) * Number(nftTraits ? 1 : character.dashCooldown || 1),
      dashTimer: 0,
      dashSpeed: (tuning.dashSpeed || CONFIG.baseDashSpeed) * Number(nftTraits ? 1 : character.dashStrength || 1),
      lastMoveX: 1,
      lastMoveY: 0,
      dynamiteEvery: 0,
      droneCount: 0,
      droneTimer: 0,
      trailTimer: 0,
      runUpgradeCounts: {},
      weapon: 'pickaxe',
      unlockedWeapons: { pickaxe: true, dynamite: false, blaster: !isArena },
      dynamiteAmmo: tuning.dynamiteStartAmmo ?? CONFIG.dynamiteStartAmmo,
      blasterEnergy: (tuning.blasterEnergy || CONFIG.blasterEnergyMax) * (Number(nftTraits ? 100 : character.blasterEnergy || 100) / 100),
      blasterEnergyMax: (tuning.blasterEnergy || CONFIG.blasterEnergyMax) * (Number(nftTraits ? 100 : character.blasterEnergy || 100) / 100),
      blasterEnergyRegen: tuning.blasterRecharge || CONFIG.blasterEnergyRegen,
      blasterDamageScale: (tuning.blasterDamageMultiplier || CONFIG.blasterDamageScale) * (1 + (meta.blaster || 0) * 0.03) * Number(nftTraits ? 1 : character.blasterDamage || 1),
      blasterVolley: 1,
      emptyWeaponToast: 0
    };
    const loadout = this.runContext?.competitionSnapshot?.loadout ||
      tuning._competitionSnapshot?.loadout;
    if (loadout) {
      this.player.unlockedWeapons = {
        pickaxe: true,
        dynamite: loadout.availableWeapons?.includes('dynamite') === true,
        blaster: loadout.availableWeapons?.includes('blaster') === true
      };
      this.player.weapon = loadout.startingWeapon || 'pickaxe';
    }
    this.enemies = [];
    this.ores = [];
    this.pickups = [];
    this.particles = [];
    this.floaters = [];
    this.tracers = [];
    this.projectiles = [];
    this.portal = null;
    this.spawnTimer = 0;
    this.state = 'playing';
    this.audio.startMusic();
    this.audio.resume();
    this.generateDepth();
    this.hooks.onRunStart?.();
    this.hooks.onToast?.(isArena
      ? 'Pickaxe ready - MATT Arena live'
      : 'SAFE START - Pickaxe ready');
  },
  generateDepth() {
    const arenaMode = this.runContext?.mode === 'arena';
    const tuning = this.runContext?.tuning || {};
    const competitionSnapshot = this.runContext?.competitionSnapshot ||
      tuning._competitionSnapshot;
    const authoredMap = competitionSnapshot
      ? competitionMapForDepth(competitionSnapshot, this.run.depth)
      : null;
    this.layout = authoredMap
      ? materializeCompetitionMap(authoredMap)
      : createMineLayout(tuning.roomsPerDepth || CONFIG.roomsPerDepth, tuning);
    if (!authoredMap && !arenaMode && this.layout.guardianRoom) {
      this.layout.guardianRoom.width = Math.max(this.layout.guardianRoom.width, tuning.bossRoomWidth || 520);
      this.layout.guardianRoom.height = Math.max(this.layout.guardianRoom.height, tuning.bossRoomHeight || 390);
    }
    this.decor = this.makeDepthDecor();
    this.enemies = [];
    this.ores = [];
    this.pickups = [];
    this.portal = null;
    this.projectiles = [];
    this.hazards = [];
    this.roomStates = Object.fromEntries(this.layout.rooms.map((room) => [room.id, {
      triggered: false,
      locked: false,
      cleared: room.type === 'start' || room.type === 'mining' || room.type === 'treasure' || room.type === 'mixed'
    }]));
    this.activeLockedRoomId = null;
    this.run.crystals = 0;
    this.run.bossKilled = false;
    this.run.bossReady = false;
    this.run.bossSpawned = false;
    this.lastRoomId = this.layout.startRoom.id;
    this.player.x = this.layout.startRoom.x;
    this.player.y = this.layout.startRoom.y;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.health = Math.min(
      this.player.maxHealth,
      this.player.health + nftHealAmount(this.runContext, this.player.maxHealth * 0.3)
    );
    this.run.safeStartUntil = this.run.elapsed +
      (arenaMode ? CONFIG.arenaSafeStartSeconds : (tuning.safeStartSeconds ?? CONFIG.safeStartSeconds));

    const luck = this.effectivePermanentMeta?.luck || 0;
    if (authoredMap) {
      this.populateCompetitionMap(this.layout.objects, luck);
      this.updateObjective();
      this.updateHud();
      return;
    }
    const oreEntries = Object.entries(ORE_TYPES)
      .filter(([id]) => id !== 'cache')
      .map(([id, ore]) => ({ id, ...ore }));
    let guaranteedCrystals = this.crystalGoal() + 2;

    for (const room of this.layout.rooms) {
      const oreCount = Math.round(({
        start: 3,
        mining: 14,
        combat: 4,
        mixed: 8,
        treasure: 5,
        guardian: 5
      }[room.type] || 6) * (tuning.oreAmountMultiplier || 1));

      for (let index = 0; index < oreCount; index += 1) {
        const shouldGuarantee = guaranteedCrystals > 0 && ['mining', 'treasure'].includes(room.type);
        const type = shouldGuarantee ? { id: 'crystal', ...ORE_TYPES.crystal } : weightedChoice(oreEntries);
        if (shouldGuarantee) guaranteedCrystals -= 1;
        this.addOre(type, room, luck);
      }

      const enemyCount = {
        start: arenaMode ? 2 : 0,
        mining: 1,
        combat: 5,
        mixed: 3,
        treasure: 2,
        guardian: 0
      }[room.type] ?? 2;
      for (let index = 0; index < enemyCount; index += 1) this.spawnEnemy(false, room);
    }
    this.enemies = this.enemies.slice(0, Math.max(0, Math.round(tuning.enemyMaximum ?? CONFIG.maxEnemiesBase)));

    while (guaranteedCrystals > 0) {
      const room = this.layout.rooms.find((entry) => entry.type === 'mining') || this.layout.rooms[1];
      this.addOre({ id: 'crystal', ...ORE_TYPES.crystal }, room, luck);
      guaranteedCrystals -= 1;
    }

    if (this.layout.treasureRoom) this.addOre({ id: 'cache', ...ORE_TYPES.cache }, this.layout.treasureRoom, luck, true);
    this.updateObjective();
    this.updateHud();
  },
  populateCompetitionMap(objects = [], luck = 0) {
    const rooms = new Map(this.layout.rooms.map((room) => [room.id, room]));
    const oreTypes = { ...ORE_TYPES, treasure: ORE_TYPES.cache, weapon_blaster: ORE_TYPES.cache, weapon_dynamite: ORE_TYPES.cache };
    let requiredCrystals = 0;
    for (const placed of objects) {
      const room = rooms.get(placed.roomId);
      if (!room || placed.type === 'player' || placed.type === 'extraction' || placed.type === 'guardian') continue;
      if (MAP_OBJECT_KINDS.enemy.includes(placed.type)) {
        for (let index = 0; index < placed.quantity; index += 1) {
          const enemy = this.spawnEnemy(false, room, placed.type);
          if (enemy) {
            enemy.x = placed.x + index * 12;
            enemy.y = placed.y + index * 9;
          }
        }
        continue;
      }
      if (oreTypes[placed.type]) {
        for (let index = 0; index < placed.quantity; index += 1) {
          const type = placed.type === 'treasure' || placed.type.startsWith('weapon_')
            ? { id: 'cache', ...ORE_TYPES.cache }
            : { id: placed.type, ...oreTypes[placed.type] };
          this.addOre(type, room, luck, type.id === 'cache');
          const ore = this.ores.at(-1);
          ore.x = placed.x + index * 13;
          ore.y = placed.y + index * 10;
          if (placed.type === 'weapon_blaster') ore.grantsWeapon = 'blaster';
          if (placed.type === 'weapon_dynamite') ore.grantsWeapon = 'dynamite';
          if (placed.type === 'crystal') requiredCrystals += 1;
        }
        continue;
      }
      if (placed.type === 'health' || placed.type === 'upgrade') {
        this.pickups.push({
          id: this.entityId++,
          type: placed.type,
          x: placed.x,
          y: placed.y,
          radius: 14,
          value: placed.type === 'health' ? 30 : 0,
          color: placed.type === 'health' ? '#ff657d' : '#68e6ff',
          vx: 0,
          vy: 0
        });
        continue;
      }
      if (MAP_OBJECT_KINDS.hazard.includes(placed.type)) {
        this.hazards.push({
          id: this.entityId++,
          type: placed.type,
          x: placed.x,
          y: placed.y,
          radius: placed.type === 'rockfall' ? 66 : 54,
          phase: 0,
          damageTimer: 0
        });
      }
    }
    const playerSpawn = objects.find((object) => object.type === 'player');
    if (playerSpawn) {
      this.player.x = playerSpawn.x;
      this.player.y = playerSpawn.y;
    }
    const extraction = objects.find((object) => object.type === 'extraction');
    this.run.customExtraction = extraction ? { x: extraction.x, y: extraction.y } : null;
    this.run.customGuardianSpawns = objects
      .filter((object) => object.type === 'guardian')
      .flatMap((object) => Array.from({ length: object.quantity }, (_, index) => ({
        x: object.x + index * 14,
        y: object.y + index * 10
      })));
    this.run.customGuardianCount = Math.max(
      1,
      objects.filter((object) => object.type === 'guardian')
        .reduce((sum, object) => sum + object.quantity, 0)
    );
    this.run.customCrystalGoal = requiredCrystals > 0 ? Math.min(requiredCrystals, 3) : 0;
    if (this.run.customCrystalGoal === 0) this.run.bossReady = true;
  },
  addOre(type, room, luck = 0, forceRich = false) {
    const tuning = this.runContext?.tuning || {};
    const position = randomPointInRoom(room, 52);
    const scale = type.id === 'cache' ? 1.25 : randomRange(0.86, 1.2);
    const richChance = (0.07 + luck * 0.01) * Number(this.runContext?.character?.luck || 1);
    const rich = forceRich || type.id === 'cache' || (type.id !== 'stone' && random() < richChance);
    const depthHealth = 1 + (this.run.depth - 1) * 0.11;
    const treasureMultiplier = type.id === 'cache' ? (tuning.treasureAmountMultiplier ?? 1) : 1;
    const hp = type.hp * depthHealth * (rich ? 1.22 : 1) * (tuning[`${type.id}HealthMultiplier`] || 1);
    this.ores.push({
      id: this.entityId++,
      kind: type.id,
      name: type.name,
      x: position.x,
      y: position.y,
      radius: 22 * scale,
      hp,
      maxHp: hp,
      nuggets: Math.round(type.nuggets * (rich ? 2 : 1) * treasureMultiplier * (tuning[`${type.id}ValueMultiplier`] ?? 1) * (tuning.nuggetMultiplier ?? 1)),
      xp: Math.round(type.xp * (rich ? 1.35 : 1) * treasureMultiplier * (tuning.xpMultiplier ?? 1)),
      color: type.color,
      rotation: randomRange(0, Math.PI * 2),
      hitFlash: 0,
      rich,
      roomId: room.id
    });
  },
  projectedPayout() {
    const tuning = this.runContext?.tuning || {};
    return Math.floor(
      this.run.rawNuggets *
      this.depthMultiplier() *
      (tuning.scoreMultiplier ?? 1) *
      (1 + (this.run.depth - 1) * ((tuning.depthScoreMultiplier ?? 1) - 1))
    );
  },
  isSafeStartActive() {
    if (!this.layout?.startRoom) return false;
    const currentRoom = roomAt(this.layout, this.player.x, this.player.y);
    return this.run.elapsed < this.run.safeStartUntil &&
      currentRoom?.id === this.layout.startRoom.id;
  },
  update(dt) {
    this.run.elapsed += dt;
    const maximumDrones = Math.max(0, Math.min(4, Math.floor(this.runContext?.tuning?.maximumDrones ?? 4)));
    this.player.droneCount = clamp(Math.floor(Number(this.player.droneCount) || 0), 0, maximumDrones);
    this.player.attackTimer -= dt;
    this.player.invulnerable -= dt;
    this.player.hitFlash -= dt;
    this.player.swingTimer -= dt;
    this.player.dashCooldown = Math.max(0, this.player.dashCooldown - dt);
    this.player.dashTimer = Math.max(0, this.player.dashTimer - dt);
    this.player.droneTimer -= dt;
    this.player.trailTimer -= dt;
    this.player.emptyWeaponToast -= dt;
    this.player.blasterEnergy = Math.min(
      this.player.blasterEnergyMax,
      this.player.blasterEnergy + this.player.blasterEnergyRegen * dt
    );
    this.camera.shake = Math.max(0, this.camera.shake - dt * 27);

    const selectedWeapon = this.input.consumeWeaponSelection();
    if (selectedWeapon) this.switchWeapon(selectedWeapon);

    this.updatePlayerMovement(dt);
    this.updateAim();
    if (this.input.attacking() && this.player.attackTimer <= 0) this.attack();
    this.updateDrone(dt);
    this.updateProjectiles(dt);
    this.updateEnemies(dt);
    this.updatePickups(dt);
    this.updateCompetitionHazards(dt);
    this.updateEffects(dt);
    this.updatePortal();
    this.updateCamera(dt);
    this.updateCurrentRoom();
    this.updateObjective();
    this.updateHud();
  },
  updateCompetitionHazards(dt) {
    if (!Array.isArray(this.hazards) || !this.hazards.length) return;
    for (const hazard of this.hazards) {
      hazard.phase += dt;
      hazard.damageTimer = Math.max(0, hazard.damageTimer - dt);
      const range = Math.hypot(this.player.x - hazard.x, this.player.y - hazard.y);
      if (range > hazard.radius + this.player.radius || hazard.damageTimer > 0) continue;
      if (hazard.type === 'crystal_field') {
        hazard.damageTimer = 0.72;
        this.damagePlayer(9, Math.atan2(this.player.y - hazard.y, this.player.x - hazard.x));
      } else if (hazard.type === 'rockfall' && hazard.phase % 2.8 > 2.05) {
        hazard.damageTimer = 1.2;
        this.damagePlayer(22, Math.atan2(this.player.y - hazard.y, this.player.x - hazard.x));
      }
    }
  },
  updatePlayerMovement(dt) {
    const move = this.input.movement();
    const moveLength = Math.hypot(move.x, move.y);
    if (moveLength > 0.08) {
      this.player.lastMoveX = move.x;
      this.player.lastMoveY = move.y;
    }

    if (this.input.consumeDash() && this.player.dashCooldown <= 0) {
      let dashX = moveLength > 0.08 ? move.x : Math.cos(this.player.angle);
      let dashY = moveLength > 0.08 ? move.y : Math.sin(this.player.angle);
      const length = Math.hypot(dashX, dashY) || 1;
      dashX /= length;
      dashY /= length;
      this.player.vx = dashX * this.player.dashSpeed;
      this.player.vy = dashY * this.player.dashSpeed;
      const dashDuration = this.runContext?.tuning?.dashDuration ?? CONFIG.dashDuration;
      this.player.dashTimer = dashDuration;
      this.player.dashCooldown = this.player.dashCooldownMax;
      this.player.invulnerable = Math.max(this.player.invulnerable, dashDuration + 0.08);
      this.player.trailTimer = 0;
      this.camera.shake = 5;
      this.burst(this.player.x, this.player.y, '#70d9ff', 10);
      this.audio.play('dash');
    }

    if (this.player.dashTimer > 0) {
      this.moveEntity(this.player, this.player.vx * dt, this.player.vy * dt);
      if (this.player.trailTimer <= 0) {
        this.player.trailTimer = 0.025;
        this.particles.push({
          x: this.player.x,
          y: this.player.y,
          vx: -this.player.vx * 0.08 + randomRange(-20, 20),
          vy: -this.player.vy * 0.08 + randomRange(-20, 20),
          radius: randomRange(5, 10),
          color: '#70d9ff',
          life: 0.22,
          maxLife: 0.22
        });
      }
      return;
    }

    const targetVx = move.x * this.player.speed;
    const targetVy = move.y * this.player.speed;
    const tuning = this.runContext?.tuning || {};
    const response = moveLength > 0.04
      ? tuning.playerAcceleration || CONFIG.playerAcceleration
      : tuning.playerFriction || CONFIG.playerFriction;
    const blend = Math.min(1, response * dt);
    this.player.vx += (targetVx - this.player.vx) * blend;
    this.player.vy += (targetVy - this.player.vy) * blend;
    if (moveLength < 0.04 && Math.hypot(this.player.vx, this.player.vy) < 4) {
      this.player.vx = 0;
      this.player.vy = 0;
    }
    this.moveEntity(this.player, this.player.vx * dt, this.player.vy * dt);
    if (
      this.cosmetics?.trail === 'gold_trail' &&
      moveLength > 0.08 &&
      this.player.trailTimer <= 0
    ) {
      this.player.trailTimer = 0.055;
      this.particles.push({
        x: this.player.x - this.player.lastMoveX * 20,
        y: this.player.y - this.player.lastMoveY * 20,
        vx: randomRange(-12, 12),
        vy: randomRange(-18, 4),
        radius: randomRange(3, 7),
        color: '#ffd95a',
        life: 0.42,
        maxLife: 0.42
      });
    }
  },
  beginBossTelemetry(enemy, phase) {
    const telemetry = this.run?.bossTelemetry;
    if (!telemetry || !enemy?.isBoss) return;
    if (!telemetry.encounterStartedAt) telemetry.encounterStartedAt = this.run.elapsed;
    telemetry.bosses[enemy.id] ||= {
      bossId: enemy.id,
      startedAt: this.run.elapsed,
      endedAt: 0,
      currentPhase: phase,
      phaseStartedAt: this.run.elapsed,
      phaseDurations: { 1: 0, 2: 0, 3: 0 },
      attacksUsed: {}
    };
  },
  transitionBossTelemetry(enemy, phase) {
    const boss = this.run?.bossTelemetry?.bosses?.[enemy?.id];
    if (!boss) return;
    const previous = boss.currentPhase || 1;
    boss.phaseDurations[previous] += Math.max(0, this.run.elapsed - boss.phaseStartedAt);
    boss.currentPhase = phase;
    boss.phaseStartedAt = this.run.elapsed;
  },
  recordBossAttack(enemy, phase, attackType) {
    this.beginBossTelemetry(enemy, phase);
    const telemetry = this.run?.bossTelemetry;
    const boss = telemetry?.bosses?.[enemy?.id];
    if (!boss) return;
    telemetry.attacksUsed[attackType] = (telemetry.attacksUsed[attackType] || 0) + 1;
    boss.attacksUsed[attackType] = (boss.attacksUsed[attackType] || 0) + 1;
  },
  finishBossTelemetry(enemy) {
    const telemetry = this.run?.bossTelemetry;
    const boss = telemetry?.bosses?.[enemy?.id];
    if (!boss || boss.endedAt) return;
    boss.phaseDurations[boss.currentPhase] += Math.max(0, this.run.elapsed - boss.phaseStartedAt);
    boss.endedAt = this.run.elapsed;
    telemetry.encounterEndedAt = Math.max(telemetry.encounterEndedAt, this.run.elapsed);
  },
  damagePlayer(amount, sourceAngle, source = {}) {
    if (this.player.invulnerable > 0) return;
    const finalDamage = Math.max(1, amount * (1 - this.player.armor));
    const shieldDamage = Math.min(Math.max(0, this.player.shield || 0), finalDamage);
    if (shieldDamage > 0) this.player.shield -= shieldDamage;
    const healthDamage = Math.max(0, finalDamage - shieldDamage);
    this.player.health -= healthDamage;
    if (source.bossId && this.run?.bossTelemetry) {
      this.run.bossTelemetry.damageReceived += finalDamage;
    }
    this.player.invulnerable = 0.5;
    this.player.hitFlash = 0.18;
    this.player.vx += Math.cos(sourceAngle) * 250;
    this.player.vy += Math.sin(sourceAngle) * 250;
    this.moveEntity(this.player, Math.cos(sourceAngle) * 24, Math.sin(sourceAngle) * 24);
    this.camera.shake = 9;
    this.audio.play('playerDamage');
    this.addFloater(
      this.player.x,
      this.player.y - 35,
      shieldDamage === finalDamage
        ? `-${Math.round(shieldDamage)} SHIELD`
        : `-${Math.round(healthDamage)}${shieldDamage > 0 ? ' HEALTH' : ''}`,
      shieldDamage === finalDamage ? '#65c9ff' : '#ff8292'
    );
    this.hooks.onArenaEvent?.({
      type: 'damage_taken',
      tick: Math.round(this.run.elapsed * 1_000),
      amount: finalDamage
    });
    if (this.player.health <= 0) {
      if (this.run?.bossTelemetry?.encounterStartedAt) this.run.bossTelemetry.playerDeaths += 1;
      this.endRun(false);
    }
  },
  updatePickups(dt) {
    for (const pickup of this.pickups) {
      pickup.vx *= 0.92;
      pickup.vy *= 0.92;
      pickup.x += pickup.vx * dt;
      pickup.y += pickup.vy * dt;
      const dist = distance(pickup, this.player);
      if (dist < this.player.magnetRange) {
        const angle = angleTo(pickup, this.player);
        const pull = 280 + (this.player.magnetRange - dist) * 5;
        pickup.x += Math.cos(angle) * pull * dt;
        pickup.y += Math.sin(angle) * pull * dt;
      }
      if (dist < pickup.radius + this.player.radius + 5) {
        if (pickup.type === 'health') {
          this.player.health = Math.min(this.player.maxHealth, this.player.health + pickup.value);
          this.addFloater(this.player.x, this.player.y - 52, `+${pickup.value} HEALTH`, '#ff8798');
        } else if (pickup.type === 'upgrade') {
          this.gainXp(this.player.nextXp);
          this.addFloater(this.player.x, this.player.y - 52, 'UPGRADE READY', '#68e6ff');
        } else {
          this.run.rawNuggets += pickup.value;
        }
        if (pickup.type === 'crystal') {
          const carryLimit = Number(this.runContext?.tuning?.nftCrystalCarryLimit || Number.MAX_SAFE_INTEGER);
          if (this.run.crystalsCollected >= carryLimit) {
            this.addFloater(this.player.x, this.player.y - 52, 'CRYSTAL PACK FULL', '#ffcf73');
            continue;
          }
          this.run.crystals += 1;
          this.run.crystalsCollected += 1;
          this.audio.play('crystal');
          this.addFloater(this.player.x, this.player.y - 52, 'MATT CRYSTAL', CONFIG.colors.crystal);
        }
        pickup.collected = true;
      }
    }
    this.pickups = this.pickups.filter((pickup) => !pickup.collected);

    const goal = this.crystalGoal();
    if (this.run.crystals >= goal && !this.run.bossReady) {
      this.run.bossReady = true;
      this.hooks.onToast?.(`${this.layout.guardianRoom.name} unlocked`);
    }
    this.updateObjective();
  },
  endRun(extracted) {
    if (!this.run || ['ended', 'menu'].includes(this.state)) return;
    const projected = this.projectedPayout();
    const banked = extracted
      ? projected
      : Math.floor(projected * (this.runContext?.tuning?.deathKeepFraction ?? CONFIG.deathKeepFraction));
    if (this.runContext?.mode !== 'arena' && !this.headless) {
      this.profile.bankedNuggets += banked;
      this.profile.bestDepth = Math.max(this.profile.bestDepth, this.run.depth);
      this.profile.bestScore = Math.max(this.profile.bestScore, projected);
      this.profile.totalRuns += 1;
    }
    this.run.displayedScore = projected;
    for (const enemy of this.enemies.filter((entry) => entry.isBoss)) {
      this.finishBossTelemetry(enemy);
    }
    this.state = 'ended';
    this.camera.shake = 0;
    this.audio.stopBoss();
    this.audio.stopMusic();
    if (extracted) this.audio.play('extract');
    this.hooks.onArenaEvent?.({
      type: extracted ? 'extract' : 'knockout',
      tick: Math.round(this.run.elapsed * 1_000)
    });
    if (this.runContext?.mode !== 'arena' && !this.headless) {
      this.hooks.onProfileChanged?.(this.profile);
    }
    this.hooks.onRunEnd?.({
      extracted,
      banked,
      lost: Math.max(0, projected - banked),
      projected,
      depth: this.run.depth,
      kills: this.run.kills,
      oreBroken: this.run.oreBroken,
      elapsed: this.run.elapsed,
      bossTelemetry: structuredClone(this.run.bossTelemetry),
      crystalsCarried: Math.max(0, Math.floor(this.run.crystalsCollected || 0)),
      completedPhases: completedPhaseMask(this.run.depth, extracted)
    });
  },
  backToMenu() {
    this.runtimeError = null;
    this.state = 'menu';
    this.audio.stopBoss();
    this.audio.stopMusic();
    this.hooks.onMenu?.();
  },
  abandonRun() {
    if (!this.run || ['ended', 'menu'].includes(this.state)) return false;
    const context = {
      mode: this.runContext?.mode || 'practice',
      elapsed: this.run.elapsed
    };
    this.runtimeError = null;
    this.state = 'menu';
    this.camera.shake = 0;
    this.projectiles = [];
    this.audio.stopBoss();
    this.audio.stopMusic();
    this.hooks.onRunAbandoned?.(context);
    this.hooks.onMenu?.();
    return true;
  },
  updateObjective() {
    const goal = this.crystalGoal();
    let text;
    if (this.isSafeStartActive()) {
      text = `SAFE START - Pickaxe ready - Move when you are ready`;
    } else if (this.activeLockedRoomId) {
      const room = this.layout.rooms.find((entry) => entry.id === this.activeLockedRoomId);
      const remaining = this.enemies.filter((enemy) => enemy.roomId === this.activeLockedRoomId && enemy.awake).length;
      if (room?.type === 'guardian') {
        const guardian = this.enemies.find((enemy) => enemy.isBoss);
        const phase = guardian ? bossPhaseForHealth(guardian.hp, guardian.maxHp) : 3;
        text = `Guardian phase ${phase} · ${remaining} threat${remaining === 1 ? '' : 's'} remaining`;
      } else text = `Room sealed · ${remaining} enem${remaining === 1 ? 'y' : 'ies'} remaining`;
    } else if (this.run.bossKilled) text = 'Return to the extraction lift';
    else if (this.run.bossSpawned) text = 'Defeat the Guardian';
    else if (this.run.bossReady) text = 'Enter the Guardian Vault';
    else text = `MATT crystals: ${this.run.crystals} / ${goal}`;
    this.hooks.onObjective?.(text);
  },
  updateHud() {
    const room = this.layout ? roomAt(this.layout, this.player.x, this.player.y) : null;
    this.hooks.onHud?.({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      shield: this.player.shield || 0,
      maxShield: this.player.maxShield || 0,
      minerLevel: this.player.minerLevel || 0,
      crystalCarryCapacity: this.player.crystalCarryCapacity || 0,
      crystalDeathRetentionBps: this.player.crystalDeathRetentionBps || 0,
      level: this.player.level,
      xp: this.player.xp,
      nextXp: this.player.nextXp,
      depth: this.run.depth,
      loot: this.projectedPayout(),
      multiplier: this.depthMultiplier(),
      dashReady: 1 - clamp(this.player.dashCooldown / this.player.dashCooldownMax, 0, 1),
      room: room?.name || 'Mine Tunnel',
      weapon: this.player.weapon,
      weapons: {
        pickaxe: { unlocked: true, value: 'READY' },
        dynamite: { unlocked: this.player.unlockedWeapons.dynamite, value: `${this.player.dynamiteAmmo}` },
        blaster: {
          unlocked: this.player.unlockedWeapons.blaster,
          value: `${Math.round((this.player.blasterEnergy / this.player.blasterEnergyMax) * 100)}%`
        }
      }
    });
  }
};

function completedPhaseMask(depth, extracted) {
  const completedDepths = extracted
    ? Math.max(1, Math.min(5, Math.floor(Number(depth) || 1)))
    : Math.max(0, Math.min(5, Math.floor(Number(depth) || 1) - 1));
  let mask = 0;
  for (let index = 0; index < completedDepths; index += 1) mask |= 1 << index;
  return mask;
}
