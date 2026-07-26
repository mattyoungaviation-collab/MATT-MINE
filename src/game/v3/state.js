import { CONFIG, ORE_TYPES } from '../config.js';
import { createMineLayout, roomAt } from '../layout.js';
import { clamp, randomRange, weightedChoice } from '../utils.js';
import { bossPhaseForHealth, roomRequiresLock } from '../combat.js';

export const stateMethods = {
  startRun() {
    this.runtimeError = null;
    this.entityId = 1;
    const isArena = this.runContext?.mode === 'arena';
    const meta = isArena ? {} : this.profile.meta;
    const maxHealth = CONFIG.basePlayerHealth + (meta.health || 0) * 8;
    this.run = {
      depth: 1,
      rawNuggets: 0,
      displayedScore: 0,
      kills: 0,
      oreBroken: 0,
      crystals: 0,
      bossKilled: false,
      bossSpawned: false,
      elapsed: 0,
      runLevelUps: 0,
      startedAt: Date.now(),
      lootMultiplier: 1,
      attackCounter: 0
    };
    this.player = {
      x: CONFIG.worldWidth / 2,
      y: CONFIG.worldHeight / 2,
      vx: 0,
      vy: 0,
      radius: CONFIG.playerRadius,
      maxHealth,
      health: maxHealth,
      speed: CONFIG.basePlayerSpeed * (1 + (meta.speed || 0) * 0.02),
      damage: CONFIG.baseDamage * (1 + (meta.damage || 0) * 0.05),
      attackCooldown: CONFIG.baseAttackCooldown,
      attackTimer: 0,
      attackRange: CONFIG.baseAttackRange,
      critChance: CONFIG.baseCritChance,
      magnetRange: CONFIG.baseMagnetRange + (meta.magnet || 0) * 6,
      armor: Math.min(0.25, (meta.armor || 0) * 0.01),
      level: 1,
      xp: 0,
      nextXp: 45,
      angle: 0,
      hitFlash: 0,
      invulnerable: 0,
      swingTimer: 0,
      dashCooldown: 0,
      dashCooldownMax: CONFIG.baseDashCooldown / (1 + (meta.dash || 0) * 0.02),
      dashTimer: 0,
      dashSpeed: CONFIG.baseDashSpeed,
      lastMoveX: 1,
      lastMoveY: 0,
      dynamiteEvery: 0,
      droneCount: 0,
      droneTimer: 0,
      trailTimer: 0,
      weapon: isArena ? 'pickaxe' : 'blaster',
      unlockedWeapons: { pickaxe: true, dynamite: false, blaster: !isArena },
      dynamiteAmmo: CONFIG.dynamiteStartAmmo,
      blasterEnergy: CONFIG.blasterEnergyMax,
      blasterEnergyMax: CONFIG.blasterEnergyMax,
      blasterEnergyRegen: CONFIG.blasterEnergyRegen,
      blasterDamageScale: CONFIG.blasterDamageScale * (1 + (meta.blaster || 0) * 0.03),
      blasterVolley: 1,
      emptyWeaponToast: 0
    };
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
    this.hooks.onToast?.('Depth 1: Search the connected chambers');
  },
  generateDepth() {
    this.layout = createMineLayout();
    if (this.runContext?.mode !== 'arena' && this.layout.guardianRoom) {
      this.layout.guardianRoom.width = Math.max(this.layout.guardianRoom.width, 520);
      this.layout.guardianRoom.height = Math.max(this.layout.guardianRoom.height, 390);
    }
    this.decor = this.makeDepthDecor();
    this.enemies = [];
    this.ores = [];
    this.pickups = [];
    this.portal = null;
    this.projectiles = [];
    this.roomStates = Object.fromEntries(this.layout.rooms.map((room) => [room.id, {
      triggered: false,
      locked: false,
      cleared: room.type === 'start' || room.type === 'mining' || room.type === 'treasure' || room.type === 'mixed'
    }]));
    this.activeLockedRoomId = null;
    this.run.crystals = 0;
    this.run.bossKilled = false;
    this.run.bossSpawned = false;
    this.lastRoomId = this.layout.startRoom.id;
    this.player.x = this.layout.startRoom.x;
    this.player.y = this.layout.startRoom.y;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.health = Math.min(this.player.maxHealth, this.player.health + this.player.maxHealth * 0.3);

    const luck = this.runContext?.mode === 'arena' ? 0 : this.profile.meta.luck || 0;
    const oreEntries = Object.entries(ORE_TYPES)
      .filter(([id]) => id !== 'cache')
      .map(([id, ore]) => ({ id, ...ore }));
    let guaranteedCrystals = this.crystalGoal() + 2;

    for (const room of this.layout.rooms) {
      const oreCount = {
        start: 3,
        mining: 14,
        combat: 4,
        mixed: 8,
        treasure: 5,
        guardian: 5
      }[room.type] || 6;

      for (let index = 0; index < oreCount; index += 1) {
        const shouldGuarantee = guaranteedCrystals > 0 && ['mining', 'treasure'].includes(room.type);
        const type = shouldGuarantee ? { id: 'crystal', ...ORE_TYPES.crystal } : weightedChoice(oreEntries);
        if (shouldGuarantee) guaranteedCrystals -= 1;
        this.addOre(type, room, luck);
      }

      const enemyCount = {
        start: 0,
        mining: 1,
        combat: 5,
        mixed: 3,
        treasure: 2,
        guardian: 0
      }[room.type] || 2;
      for (let index = 0; index < enemyCount; index += 1) this.spawnEnemy(false, room);
    }

    while (guaranteedCrystals > 0) {
      const room = this.layout.rooms.find((entry) => entry.type === 'mining') || this.layout.rooms[1];
      this.addOre({ id: 'crystal', ...ORE_TYPES.crystal }, room, luck);
      guaranteedCrystals -= 1;
    }

    if (this.layout.treasureRoom) this.addOre({ id: 'cache', ...ORE_TYPES.cache }, this.layout.treasureRoom, luck, true);
    this.updateObjective();
    this.updateHud();
  },
  update(dt) {
    this.run.elapsed += dt;
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
    this.updateEffects(dt);
    this.updatePortal();
    this.updateCamera(dt);
    this.updateCurrentRoom();
    this.updateObjective();
    this.updateHud();
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
      this.player.dashTimer = CONFIG.dashDuration;
      this.player.dashCooldown = this.player.dashCooldownMax;
      this.player.invulnerable = Math.max(this.player.invulnerable, CONFIG.dashDuration + 0.08);
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
    const response = moveLength > 0.04 ? CONFIG.playerAcceleration : CONFIG.playerFriction;
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
  damagePlayer(amount, sourceAngle) {
    if (this.player.invulnerable > 0) return;
    const finalDamage = Math.max(1, amount * (1 - this.player.armor));
    this.player.health -= finalDamage;
    this.player.invulnerable = 0.5;
    this.player.hitFlash = 0.18;
    this.player.vx += Math.cos(sourceAngle) * 250;
    this.player.vy += Math.sin(sourceAngle) * 250;
    this.moveEntity(this.player, Math.cos(sourceAngle) * 24, Math.sin(sourceAngle) * 24);
    this.camera.shake = 9;
    this.audio.play('playerDamage');
    this.addFloater(this.player.x, this.player.y - 35, `-${Math.round(finalDamage)}`, '#ff8292');
    this.hooks.onArenaEvent?.({
      type: 'damage_taken',
      tick: Math.round(this.run.elapsed * 1_000),
      amount: finalDamage
    });
    if (this.player.health <= 0) this.endRun(false);
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
        this.run.rawNuggets += pickup.value;
        if (pickup.type === 'crystal') {
          this.run.crystals += 1;
          this.audio.play('crystal');
          this.addFloater(this.player.x, this.player.y - 52, 'MATT CRYSTAL', CONFIG.colors.crystal);
        }
        pickup.collected = true;
      }
    }
    this.pickups = this.pickups.filter((pickup) => !pickup.collected);

    const goal = this.crystalGoal();
    if (this.run.crystals >= goal && !this.run.bossSpawned) {
      this.run.bossSpawned = true;
      this.spawnEnemy(true);
      const guardian = this.enemies.find((enemy) => enemy.isBoss);
      if (guardian) guardian.awake = true;
      const currentRoom = roomAt(this.layout, this.player.x, this.player.y);
      if (currentRoom?.id === this.layout.guardianRoom.id) this.lockRoom(currentRoom);
      this.hooks.onToast?.(`Guardian awakened in ${this.layout.guardianRoom.name}`);
    }
    this.updateObjective();
  },
  endRun(extracted) {
    if (!this.run || ['ended', 'menu'].includes(this.state)) return;
    const projected = this.projectedPayout();
    const banked = extracted ? projected : Math.floor(projected * CONFIG.deathKeepFraction);
    if (this.runContext?.mode !== 'arena' && !this.headless) {
      this.profile.bankedNuggets += banked;
      this.profile.bestDepth = Math.max(this.profile.bestDepth, this.run.depth);
      this.profile.bestScore = Math.max(this.profile.bestScore, projected);
      this.profile.totalRuns += 1;
    }
    this.run.displayedScore = projected;
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
      elapsed: this.run.elapsed
    });
  },
  backToMenu() {
    this.runtimeError = null;
    this.state = 'menu';
    this.audio.stopBoss();
    this.audio.stopMusic();
    this.hooks.onMenu?.();
  },
  updateObjective() {
    const goal = this.crystalGoal();
    let text;
    if (this.activeLockedRoomId) {
      const room = this.layout.rooms.find((entry) => entry.id === this.activeLockedRoomId);
      const remaining = this.enemies.filter((enemy) => enemy.roomId === this.activeLockedRoomId && enemy.awake).length;
      if (room?.type === 'guardian') {
        const guardian = this.enemies.find((enemy) => enemy.isBoss);
        const phase = guardian ? bossPhaseForHealth(guardian.hp, guardian.maxHp) : 3;
        text = `Guardian phase ${phase} · ${remaining} threat${remaining === 1 ? '' : 's'} remaining`;
      } else text = `Room sealed · ${remaining} enem${remaining === 1 ? 'y' : 'ies'} remaining`;
    } else if (this.run.bossKilled) text = 'Return to the extraction lift';
    else if (this.run.bossSpawned) text = `Enter the Guardian Vault and defeat the Guardian`;
    else text = `MATT crystals: ${this.run.crystals} / ${goal}`;
    this.hooks.onObjective?.(text);
  },
  updateHud() {
    const room = this.layout ? roomAt(this.layout, this.player.x, this.player.y) : null;
    this.hooks.onHud?.({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
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
