import { CONFIG, ORE_TYPES, RUN_UPGRADES } from './config.js';
import { InputController } from './input.js';
import { createMineLayout, pointInLayout, randomPointInRoom, roomAt } from './layout.js';
import {
  angleTo,
  clamp,
  distance,
  formatNumber,
  pickUnique,
  randomInt,
  randomRange,
  weightedChoice
} from './utils.js';

const TAU = Math.PI * 2;

export class MattMineGame {
  constructor(canvas, profile, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.profile = profile;
    this.hooks = hooks;
    this.input = new InputController(canvas);
    this.state = 'menu';
    this.lastTime = performance.now();
    this.camera = { x: 0, y: 0, shake: 0 };
    this.entityId = 1;
    this.layout = null;
    this.decor = [];
    this.lastRoomId = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame((time) => this.loop(time));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const logicalWidth = CONFIG.width;
    const logicalHeight = CONFIG.height;
    this.canvas.width = Math.round(logicalWidth * dpr);
    this.canvas.height = Math.round(logicalHeight * dpr);
    this.canvas.dataset.logicalWidth = logicalWidth;
    this.canvas.dataset.logicalHeight = logicalHeight;
    this.canvas.style.aspectRatio = `${logicalWidth} / ${logicalHeight}`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewportWidth = logicalWidth;
    this.viewportHeight = logicalHeight;
  }

  setProfile(profile) {
    this.profile = profile;
  }

  startRun() {
    const meta = this.profile.meta;
    const maxHealth = CONFIG.basePlayerHealth + meta.health * 8;
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
      speed: CONFIG.basePlayerSpeed * (1 + meta.speed * 0.02),
      damage: CONFIG.baseDamage * (1 + meta.damage * 0.05),
      attackCooldown: CONFIG.baseAttackCooldown,
      attackTimer: 0,
      attackRange: CONFIG.baseAttackRange,
      critChance: CONFIG.baseCritChance,
      magnetRange: CONFIG.baseMagnetRange,
      armor: 0,
      level: 1,
      xp: 0,
      nextXp: 45,
      angle: 0,
      hitFlash: 0,
      invulnerable: 0,
      swingTimer: 0,
      dashCooldown: 0,
      dashCooldownMax: CONFIG.baseDashCooldown,
      dashTimer: 0,
      dashSpeed: CONFIG.baseDashSpeed,
      lastMoveX: 1,
      lastMoveY: 0,
      dynamiteEvery: 0,
      droneCount: 0,
      droneTimer: 0,
      trailTimer: 0
    };
    this.enemies = [];
    this.ores = [];
    this.pickups = [];
    this.particles = [];
    this.floaters = [];
    this.tracers = [];
    this.portal = null;
    this.spawnTimer = 0;
    this.state = 'playing';
    this.generateDepth();
    this.hooks.onRunStart?.();
    this.hooks.onToast?.('Depth 1: Search the connected chambers');
  }

  generateDepth() {
    this.layout = createMineLayout();
    this.decor = this.makeDepthDecor();
    this.enemies = [];
    this.ores = [];
    this.pickups = [];
    this.portal = null;
    this.run.crystals = 0;
    this.run.bossKilled = false;
    this.run.bossSpawned = false;
    this.lastRoomId = this.layout.startRoom.id;
    this.player.x = this.layout.startRoom.x;
    this.player.y = this.layout.startRoom.y;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.health = Math.min(this.player.maxHealth, this.player.health + this.player.maxHealth * 0.3);

    const luck = this.profile.meta.luck || 0;
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
        guardian: 2
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
  }

  makeDepthDecor() {
    const items = [];
    for (const room of this.layout.rooms) {
      const count = randomInt(6, 12);
      for (let index = 0; index < count; index += 1) {
        const point = randomPointInRoom(room, 24);
        items.push({
          x: point.x,
          y: point.y,
          radius: randomRange(3, 15),
          alpha: randomRange(0.035, 0.13),
          rotation: randomRange(0, TAU)
        });
      }
    }
    return items;
  }

  addOre(type, room, luck = 0, forceRich = false) {
    const position = randomPointInRoom(room, 52);
    const scale = type.id === 'cache' ? 1.25 : randomRange(0.86, 1.2);
    const richChance = 0.07 + luck * 0.01;
    const rich = forceRich || type.id === 'cache' || (type.id !== 'stone' && Math.random() < richChance);
    const depthHealth = 1 + (this.run.depth - 1) * 0.11;
    const hp = type.hp * depthHealth * (rich ? 1.22 : 1);
    this.ores.push({
      id: this.entityId++,
      kind: type.id,
      name: type.name,
      x: position.x,
      y: position.y,
      radius: 22 * scale,
      hp,
      maxHp: hp,
      nuggets: Math.round(type.nuggets * (rich ? 2 : 1)),
      xp: Math.round(type.xp * (rich ? 1.35 : 1)),
      color: type.color,
      rotation: randomRange(0, TAU),
      hitFlash: 0,
      rich,
      roomId: room.id
    });
  }

  spawnEnemy(isBoss = false, requestedRoom = null) {
    let room = requestedRoom;
    if (isBoss) room = this.layout.guardianRoom;
    if (!room) {
      const currentRoom = roomAt(this.layout, this.player.x, this.player.y);
      const candidates = this.layout.rooms.filter((entry) => entry.type !== 'start');
      room = currentRoom && currentRoom.type !== 'start' ? currentRoom : candidates[randomInt(0, candidates.length - 1)];
    }

    let position = randomPointInRoom(room, isBoss ? 86 : 52);
    let attempts = 0;
    while (distance(position, this.player) < 170 && attempts < 20) {
      position = randomPointInRoom(room, 52);
      attempts += 1;
    }

    const depthScale = 1 + (this.run.depth - 1) * 0.28;
    const roll = Math.random();
    let type = roll < 0.2 ? 'bat' : roll < 0.42 ? 'crawler' : 'slime';
    if (isBoss) type = 'guardian';
    const stats = {
      slime: { radius: 21, health: 46, speed: 82, damage: 9, xp: 14, color: '#e94f64' },
      bat: { radius: 16, health: 30, speed: 135, damage: 7, xp: 11, color: '#ff8b5e' },
      crawler: { radius: 25, health: 72, speed: 62, damage: 13, xp: 20, color: '#d94b9d' },
      guardian: { radius: 54, health: 500, speed: 58, damage: 24, xp: 140, color: CONFIG.colors.boss }
    }[type];

    this.enemies.push({
      id: this.entityId++,
      type,
      isBoss,
      x: position.x,
      y: position.y,
      vx: 0,
      vy: 0,
      knockbackX: 0,
      knockbackY: 0,
      radius: stats.radius * (isBoss ? 1 + (this.run.depth - 1) * 0.05 : 1),
      hp: stats.health * depthScale,
      maxHp: stats.health * depthScale,
      speed: stats.speed * (1 + (this.run.depth - 1) * 0.06),
      damage: stats.damage * depthScale,
      xp: Math.round(stats.xp * depthScale),
      color: stats.color,
      hitFlash: 0,
      contactTimer: 0,
      phase: randomRange(0, TAU),
      roomId: room.id
    });
  }

  loop(time) {
    const dt = Math.min((time - this.lastTime) / 1000, 0.033);
    this.lastTime = time;
    if (this.state === 'playing') this.update(dt);
    this.render();
    requestAnimationFrame((next) => this.loop(next));
  }

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
    this.camera.shake = Math.max(0, this.camera.shake - dt * 27);

    this.updatePlayerMovement(dt);
    this.updateAim();
    if (this.input.attacking() && this.player.attackTimer <= 0) this.attack();
    this.updateDrone(dt);

    this.spawnTimer -= dt;
    const maxEnemies = CONFIG.maxEnemiesBase + this.run.depth * 3;
    if (this.spawnTimer <= 0 && this.enemies.filter((enemy) => !enemy.isBoss).length < maxEnemies) {
      this.spawnEnemy(false);
      this.spawnTimer = Math.max(0.62, CONFIG.enemySpawnInterval - this.run.depth * 0.1);
    }

    this.updateEnemies(dt);
    this.updatePickups(dt);
    this.updateEffects(dt);
    this.updatePortal();
    this.updateCamera(dt);
    this.updateCurrentRoom();
    this.updateHud();
  }

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
  }

  moveEntity(entity, dx, dy) {
    const padding = Math.max(8, entity.radius * 0.68);
    const nextX = clamp(entity.x + dx, entity.radius, CONFIG.worldWidth - entity.radius);
    if (pointInLayout(this.layout, nextX, entity.y, padding)) entity.x = nextX;
    else if ('vx' in entity) entity.vx = 0;
    const nextY = clamp(entity.y + dy, entity.radius, CONFIG.worldHeight - entity.radius);
    if (pointInLayout(this.layout, entity.x, nextY, padding)) entity.y = nextY;
    else if ('vy' in entity) entity.vy = 0;
  }

  updateAim() {
    const pointer = this.input.pointer;
    if (pointer.active && !this.input.mobileAttack) {
      const worldPointer = { x: pointer.x + this.camera.x, y: pointer.y + this.camera.y };
      this.player.angle = angleTo(this.player, worldPointer);
      return;
    }
    const target = this.nearestTarget(340);
    if (target) this.player.angle = angleTo(this.player, target);
    else if (Math.hypot(this.player.vx, this.player.vy) > 15) this.player.angle = Math.atan2(this.player.vy, this.player.vx);
  }

  nearestTarget(maxDistance = Infinity, enemiesOnly = false) {
    let best = null;
    let bestDistance = maxDistance;
    const pool = enemiesOnly ? this.enemies : [...this.enemies, ...this.ores];
    for (const target of pool) {
      const current = distance(this.player, target);
      if (current < bestDistance) {
        best = target;
        bestDistance = current;
      }
    }
    return best;
  }

  attack() {
    this.player.attackTimer = this.player.attackCooldown;
    this.player.swingTimer = 0.16;
    const candidates = [...this.enemies, ...this.ores]
      .map((target) => ({
        target,
        dist: distance(this.player, target),
        angleDiff: Math.abs(normalizeAngle(angleTo(this.player, target) - this.player.angle))
      }))
      .filter((entry) => entry.dist <= this.player.attackRange + entry.target.radius && entry.angleDiff < 0.88)
      .sort((a, b) => a.dist - b.dist);

    this.spawnSwingParticles();
    if (!candidates.length) return;

    const { target } = candidates[0];
    const critical = Math.random() < this.player.critChance;
    const damage = this.player.damage * (critical ? 2 : 1);
    this.damageTarget(target, damage, critical, angleTo(this.player, target));
    this.run.attackCounter += 1;

    if (this.player.dynamiteEvery > 0 && this.run.attackCounter % this.player.dynamiteEvery === 0) {
      this.explode(target.x, target.y, 125, this.player.damage * 0.72);
    }
  }

  damageTarget(target, damage, critical = false, impactAngle = 0, source = 'pick') {
    if (!target || target.hp <= 0) return;
    target.hp -= damage;
    target.hitFlash = 0.1;
    this.camera.shake = Math.max(this.camera.shake, critical ? 8 : source === 'explosion' ? 11 : 3);
    this.addFloater(
      target.x,
      target.y - target.radius,
      `${critical ? 'CRIT ' : ''}${Math.round(damage)}`,
      source === 'drone' ? '#8be9ff' : critical ? '#fff09a' : '#ffffff'
    );
    this.burst(target.x, target.y, target.color, critical ? 12 : source === 'explosion' ? 10 : 6);

    if (!('kind' in target)) {
      const knockback = target.isBoss ? 75 : source === 'explosion' ? 280 : 180;
      target.knockbackX += Math.cos(impactAngle) * knockback;
      target.knockbackY += Math.sin(impactAngle) * knockback;
    }

    if (target.hp <= 0) {
      if ('kind' in target) this.breakOre(target);
      else this.killEnemy(target);
    }
  }

  explode(x, y, radius, damage) {
    this.camera.shake = Math.max(this.camera.shake, 12);
    this.burst(x, y, '#ffb342', 28);
    this.addFloater(x, y - 30, 'BOOM', '#ffcf73');
    for (const target of [...this.enemies, ...this.ores]) {
      const dist = Math.hypot(target.x - x, target.y - y);
      if (dist > radius + target.radius) continue;
      const falloff = clamp(1 - dist / (radius + target.radius), 0.35, 1);
      const impact = Math.atan2(target.y - y, target.x - x);
      this.damageTarget(target, damage * falloff, false, impact, 'explosion');
    }
    this.tracers.push({ x1: x, y1: y, x2: x, y2: y, radius, color: '#ffb342', life: 0.22, maxLife: 0.22, ring: true });
  }

  breakOre(ore) {
    this.ores = this.ores.filter((entry) => entry.id !== ore.id);
    this.run.oreBroken += 1;
    this.gainXp(ore.xp);
    const drops = Math.max(1, Math.ceil(ore.nuggets / (ore.kind === 'cache' ? 9 : 6)));
    const baseDropValue = Math.floor(ore.nuggets / drops);
    const remainder = ore.nuggets % drops;
    for (let index = 0; index < drops; index += 1) {
      this.pickups.push({
        id: this.entityId++,
        type: ore.kind === 'crystal' && index === 0 ? 'crystal' : 'nugget',
        x: ore.x + randomRange(-18, 18),
        y: ore.y + randomRange(-18, 18),
        radius: ore.kind === 'crystal' && index === 0 ? 11 : ore.kind === 'cache' ? 9 : 7,
        value: baseDropValue + (index < remainder ? 1 : 0),
        color: ore.kind === 'crystal' && index === 0 ? CONFIG.colors.crystal : ore.kind === 'cache' ? CONFIG.colors.treasure : CONFIG.colors.pickup,
        vx: randomRange(-90, 90),
        vy: randomRange(-90, 90)
      });
    }
    if (ore.kind === 'cache') this.hooks.onToast?.('Treasure cache smashed open');
    else if (ore.rich) this.addFloater(ore.x, ore.y - 36, 'RICH VEIN', '#ffe88c');
  }

  killEnemy(enemy) {
    this.enemies = this.enemies.filter((entry) => entry.id !== enemy.id);
    this.run.kills += 1;
    this.gainXp(enemy.xp);
    const payout = enemy.isBoss ? 160 + this.run.depth * 40 : randomInt(2, 7);
    const count = enemy.isBoss ? 14 : 1;
    const baseValue = Math.floor(payout / count);
    const remainder = payout % count;
    for (let index = 0; index < count; index += 1) {
      this.pickups.push({
        id: this.entityId++,
        type: 'nugget',
        x: enemy.x + randomRange(-enemy.radius, enemy.radius),
        y: enemy.y + randomRange(-enemy.radius, enemy.radius),
        radius: enemy.isBoss ? 9 : 7,
        value: baseValue + (index < remainder ? 1 : 0),
        color: CONFIG.colors.pickup,
        vx: randomRange(-110, 110),
        vy: randomRange(-110, 110)
      });
    }
    if (enemy.isBoss) {
      this.run.bossKilled = true;
      this.hooks.onToast?.('Guardian defeated — return to the Lift Station');
      this.createPortal();
    }
  }

  gainXp(amount) {
    this.player.xp += amount;
    if (this.player.xp >= this.player.nextXp) {
      this.player.xp -= this.player.nextXp;
      this.player.level += 1;
      this.player.nextXp = Math.round(this.player.nextXp * 1.28 + 12);
      this.run.runLevelUps += 1;
      this.state = 'levelup';
      this.hooks.onLevelUp?.(pickUnique(RUN_UPGRADES, 3));
    }
  }

  chooseRunUpgrade(id) {
    const upgrade = RUN_UPGRADES.find((entry) => entry.id === id);
    if (!upgrade || this.state !== 'levelup') return;
    if (id === 'power') this.player.damage *= 1.25;
    if (id === 'speed') this.player.speed *= 1.12;
    if (id === 'health') {
      this.player.maxHealth += 25;
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 25);
    }
    if (id === 'haste') this.player.attackCooldown *= 0.85;
    if (id === 'range') this.player.attackRange *= 1.2;
    if (id === 'crit') this.player.critChance += 0.08;
    if (id === 'magnet') this.player.magnetRange += 45;
    if (id === 'armor') this.player.armor = Math.min(0.6, this.player.armor + 0.12);
    if (id === 'dash') this.player.dashCooldownMax = Math.max(0.65, this.player.dashCooldownMax * 0.75);
    if (id === 'dynamite') this.player.dynamiteEvery = this.player.dynamiteEvery ? Math.max(3, this.player.dynamiteEvery - 1) : 5;
    if (id === 'drone') this.player.droneCount = Math.min(3, this.player.droneCount + 1);
    if (id === 'fortune') this.run.lootMultiplier *= 1.15;
    this.state = 'playing';
    this.hooks.onUpgradeChosen?.(upgrade);
  }

  updateDrone() {
    if (this.player.droneCount <= 0 || this.player.droneTimer > 0) return;
    const target = this.nearestTarget(380, true);
    if (!target) return;
    this.player.droneTimer = Math.max(0.34, 0.9 - this.player.droneCount * 0.14);
    const orbit = this.dronePosition(0);
    const angle = Math.atan2(target.y - orbit.y, target.x - orbit.x);
    this.tracers.push({
      x1: orbit.x,
      y1: orbit.y,
      x2: target.x,
      y2: target.y,
      color: '#8be9ff',
      life: 0.1,
      maxLife: 0.1,
      ring: false
    });
    this.damageTarget(target, this.player.damage * (0.36 + this.player.droneCount * 0.08), false, angle, 'drone');
  }

  dronePosition(index) {
    const angle = this.run.elapsed * 2.4 + (index / Math.max(1, this.player.droneCount)) * TAU;
    return {
      x: this.player.x + Math.cos(angle) * 48,
      y: this.player.y + Math.sin(angle) * 48
    };
  }

  updateEnemies(dt) {
    const playerRoom = roomAt(this.layout, this.player.x, this.player.y);
    for (const enemy of this.enemies) {
      enemy.hitFlash -= dt;
      enemy.contactTimer -= dt;
      enemy.phase += dt * 3;
      const enemyRoom = roomAt(this.layout, enemy.x, enemy.y);
      const active = distance(enemy, this.player) < 380 || (playerRoom && enemyRoom && playerRoom.id === enemyRoom.id);

      if (active) {
        const angle = angleTo(enemy, this.player);
        const wobble = enemy.type === 'bat' ? Math.sin(enemy.phase) * 0.52 : 0;
        const targetVx = Math.cos(angle + wobble) * enemy.speed;
        const targetVy = Math.sin(angle + wobble) * enemy.speed;
        enemy.vx += (targetVx - enemy.vx) * Math.min(1, dt * 6);
        enemy.vy += (targetVy - enemy.vy) * Math.min(1, dt * 6);
      } else {
        enemy.vx *= Math.max(0, 1 - dt * 7);
        enemy.vy *= Math.max(0, 1 - dt * 7);
      }

      enemy.knockbackX *= Math.max(0, 1 - dt * 8);
      enemy.knockbackY *= Math.max(0, 1 - dt * 8);
      this.moveEntity(enemy, (enemy.vx + enemy.knockbackX) * dt, (enemy.vy + enemy.knockbackY) * dt);

      if (distance(enemy, this.player) < enemy.radius + this.player.radius && enemy.contactTimer <= 0) {
        enemy.contactTimer = enemy.isBoss ? 0.8 : 1.05;
        this.damagePlayer(enemy.damage, angleTo(enemy, this.player));
      }
    }
  }

  damagePlayer(amount, sourceAngle) {
    if (this.player.invulnerable > 0) return;
    const finalDamage = Math.max(1, amount * (1 - this.player.armor));
    this.player.health -= finalDamage;
    this.player.invulnerable = 0.5;
    this.player.hitFlash = 0.18;
    this.player.vx += Math.cos(sourceAngle) * 250;
    this.player.vy += Math.sin(sourceAngle) * 250;
    this.moveEntity(this.player, Math.cos(sourceAngle) * 24, Math.sin(sourceAngle) * 24);
    this.camera.shake = 11;
    this.addFloater(this.player.x, this.player.y - 35, `-${Math.round(finalDamage)}`, '#ff8292');
    if (this.player.health <= 0) this.endRun(false);
  }

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
      this.hooks.onToast?.(`Guardian awakened in ${this.layout.guardianRoom.name}`);
    }
    this.updateObjective();
  }

  crystalGoal() {
    return CONFIG.crystalGoalBase + Math.floor((this.run.depth - 1) / 2);
  }

  createPortal() {
    this.portal = {
      x: this.layout.startRoom.x,
      y: this.layout.startRoom.y,
      radius: 58,
      phase: 0,
      promptShown: false
    };
  }

  updatePortal() {
    if (!this.portal) return;
    this.portal.phase += 0.04;
    if (distance(this.portal, this.player) < this.portal.radius + this.player.radius + 5 && !this.portal.promptShown) {
      this.portal.promptShown = true;
      this.state = 'depthchoice';
      this.hooks.onDepthChoice?.({
        depth: this.run.depth,
        projectedPayout: this.projectedPayout(),
        nextMultiplier: this.depthMultiplier(this.run.depth + 1)
      });
    }
  }

  depthMultiplier(depth = this.run.depth) {
    return 1 + (depth - 1) * 0.5;
  }

  projectedPayout() {
    return Math.floor(this.run.rawNuggets * this.run.lootMultiplier * this.depthMultiplier());
  }

  descend() {
    if (this.state !== 'depthchoice') return;
    if (this.run.depth >= CONFIG.maxDepth) {
      this.extract();
      return;
    }
    this.run.depth += 1;
    this.state = 'playing';
    this.generateDepth();
    this.hooks.onDepthStarted?.(this.run.depth);
    this.hooks.onToast?.(`Depth ${this.run.depth}: Loot multiplier x${this.depthMultiplier().toFixed(1)}`);
  }

  extract() {
    if (this.state !== 'depthchoice') return;
    this.endRun(true);
  }

  endRun(extracted) {
    if (!this.run || ['ended', 'menu'].includes(this.state)) return;
    const projected = this.projectedPayout();
    const banked = extracted ? projected : Math.floor(projected * CONFIG.deathKeepFraction);
    this.profile.bankedNuggets += banked;
    this.profile.bestDepth = Math.max(this.profile.bestDepth, this.run.depth);
    this.profile.bestScore = Math.max(this.profile.bestScore, projected);
    this.profile.totalRuns += 1;
    this.run.displayedScore = projected;
    this.state = 'ended';
    this.hooks.onProfileChanged?.(this.profile);
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
  }

  backToMenu() {
    this.state = 'menu';
    this.hooks.onMenu?.();
  }

  updateEffects(dt) {
    for (const particle of this.particles) {
      particle.life -= dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= 0.96;
      particle.vy *= 0.96;
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
    for (const floater of this.floaters) {
      floater.life -= dt;
      floater.y -= 34 * dt;
    }
    this.floaters = this.floaters.filter((floater) => floater.life > 0);
    for (const tracer of this.tracers) tracer.life -= dt;
    this.tracers = this.tracers.filter((tracer) => tracer.life > 0);
  }

  burst(x, y, color, count) {
    for (let index = 0; index < count; index += 1) {
      const angle = randomRange(0, TAU);
      const speed = randomRange(45, 180);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: randomRange(2, 5),
        color,
        life: randomRange(0.18, 0.48),
        maxLife: 0.48
      });
    }
  }

  spawnSwingParticles() {
    const x = this.player.x + Math.cos(this.player.angle) * 58;
    const y = this.player.y + Math.sin(this.player.angle) * 58;
    this.burst(x, y, '#f5d142', 4);
  }

  addFloater(x, y, text, color) {
    this.floaters.push({ x, y, text, color, life: 0.85, maxLife: 0.85 });
  }

  updateCamera(dt) {
    const lookAheadX = clamp(this.player.vx * 0.23, -120, 120);
    const lookAheadY = clamp(this.player.vy * 0.18, -80, 80);
    const targetX = clamp(this.player.x - this.viewportWidth / 2 + lookAheadX, 0, CONFIG.worldWidth - this.viewportWidth);
    const targetY = clamp(this.player.y - this.viewportHeight / 2 + lookAheadY, 0, CONFIG.worldHeight - this.viewportHeight);
    this.camera.x += (targetX - this.camera.x) * Math.min(1, dt * 6.5);
    this.camera.y += (targetY - this.camera.y) * Math.min(1, dt * 6.5);
  }

  updateCurrentRoom() {
    const room = roomAt(this.layout, this.player.x, this.player.y);
    if (!room || room.id === this.lastRoomId) return;
    this.lastRoomId = room.id;
    if (room.type !== 'start') this.hooks.onToast?.(room.name);
  }

  updateObjective() {
    const goal = this.crystalGoal();
    let text;
    if (this.run.bossKilled) text = 'Return to the extraction lift';
    else if (this.run.bossSpawned) text = `Defeat the Guardian in ${this.layout.guardianRoom.name}`;
    else text = `MATT crystals: ${this.run.crystals} / ${goal}`;
    this.hooks.onObjective?.(text);
  }

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
      room: room?.name || 'Mine Tunnel'
    });
  }

  render() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    ctx.save();
    const shakeX = this.camera.shake ? randomRange(-this.camera.shake, this.camera.shake) : 0;
    const shakeY = this.camera.shake ? randomRange(-this.camera.shake, this.camera.shake) : 0;
    ctx.translate(-this.camera.x + shakeX, -this.camera.y + shakeY);
    this.drawWorld(ctx);
    if (this.run && this.player) {
      this.drawPortal(ctx);
      this.drawOres(ctx);
      this.drawPickups(ctx);
      this.drawEnemies(ctx);
      this.drawPlayer(ctx);
      this.drawDrones(ctx);
      this.drawParticles(ctx);
      this.drawTracers(ctx);
      this.drawFloaters(ctx);
      this.drawLighting(ctx);
    }
    ctx.restore();
  }

  drawWorld(ctx) {
    ctx.fillStyle = CONFIG.colors.background;
    ctx.fillRect(this.camera.x - 30, this.camera.y - 30, this.viewportWidth + 60, this.viewportHeight + 60);
    if (!this.layout) return;

    for (const corridor of this.layout.corridors) {
      if (!this.rectInView(corridor, 80)) continue;
      this.drawFloorRect(ctx, corridor, CONFIG.colors.floorAlt, 18);
    }

    for (const room of this.layout.rooms) {
      if (!this.rectInView(room, 100)) continue;
      const tint = {
        start: '#182031',
        mining: '#17231f',
        combat: '#23171d',
        mixed: CONFIG.colors.floor,
        treasure: '#211a30',
        guardian: '#24172c'
      }[room.type] || CONFIG.colors.floor;
      this.drawFloorRect(ctx, room, tint, 26);
      this.drawRoomGrid(ctx, room);
      this.drawRoomTorches(ctx, room);

      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.letterSpacing = '0.12em';
      ctx.fillText(room.name.toUpperCase(), room.x, room.y - room.height / 2 + 35);
      ctx.restore();
    }

    for (const rock of this.decor) {
      if (!this.inView(rock, 30)) continue;
      ctx.save();
      ctx.translate(rock.x, rock.y);
      ctx.rotate(rock.rotation);
      ctx.fillStyle = `rgba(255,255,255,${rock.alpha})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, rock.radius, rock.radius * 0.55, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  drawFloorRect(ctx, rect, color, radius) {
    const x = rect.x - rect.width / 2;
    const y = rect.y - rect.height / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 30;
    ctx.fillStyle = color;
    roundRect(ctx, x, y, rect.width, rect.height, radius);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = CONFIG.colors.wallEdge;
    ctx.lineWidth = 15;
    roundRect(ctx, x, y, rect.width, rect.height, radius);
    ctx.stroke();
    ctx.strokeStyle = CONFIG.colors.wall;
    ctx.lineWidth = 8;
    roundRect(ctx, x, y, rect.width, rect.height, radius);
    ctx.stroke();
    ctx.restore();
  }

  drawRoomGrid(ctx, room) {
    ctx.save();
    const left = room.x - room.width / 2 + 12;
    const right = room.x + room.width / 2 - 12;
    const top = room.y - room.height / 2 + 12;
    const bottom = room.y + room.height / 2 - 12;
    ctx.strokeStyle = CONFIG.colors.grid;
    ctx.lineWidth = 1;
    for (let x = left; x <= right; x += CONFIG.gridSize) {
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    }
    for (let y = top; y <= bottom; y += CONFIG.gridSize) {
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    }
    ctx.restore();
  }

  drawRoomTorches(ctx, room) {
    const pulse = 0.78 + Math.sin(performance.now() / 190 + room.id) * 0.12;
    for (const side of [-1, 1]) {
      const x = room.x + side * (room.width / 2 - 32);
      const y = room.y - room.height / 2 + 36;
      ctx.save();
      ctx.fillStyle = '#ffbe55';
      ctx.shadowColor = '#ff9d37';
      ctx.shadowBlur = 24 * pulse;
      ctx.beginPath(); ctx.arc(x, y, 5 + pulse, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  drawOres(ctx) {
    for (const ore of this.ores) {
      if (!this.inView(ore, 60)) continue;
      ctx.save();
      ctx.translate(ore.x, ore.y);
      ctx.rotate(ore.rotation);
      const glow = ore.kind === 'crystal' || ore.rich;
      if (glow) {
        ctx.shadowColor = ore.color;
        ctx.shadowBlur = 18 + Math.sin(performance.now() / 220 + ore.id) * 5;
      }
      ctx.fillStyle = ore.hitFlash > 0 ? '#ffffff' : ore.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 5;
      if (ore.kind === 'cache') {
        roundRect(ctx, -ore.radius * 1.1, -ore.radius * 0.8, ore.radius * 2.2, ore.radius * 1.6, 8);
      } else {
        polygon(ctx, 0, 0, ore.radius, ore.kind === 'crystal' ? 5 : 7);
      }
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#ffffff';
      if (ore.kind === 'cache') {
        ctx.fillRect(-ore.radius * 0.9, -ore.radius * 0.18, ore.radius * 1.8, ore.radius * 0.34);
        ctx.fillStyle = '#f5d142';
        ctx.fillRect(-4, -ore.radius * 0.26, 8, ore.radius * 0.52);
      } else {
        polygon(ctx, -ore.radius * 0.2, -ore.radius * 0.2, ore.radius * 0.42, 5);
        ctx.fill();
      }
      this.drawOreCracks(ctx, ore);
      ctx.restore();
      if (ore.hp < ore.maxHp) this.drawHealthBar(ctx, ore, ore.hp / ore.maxHp, ore.radius * 1.9, 5);
    }
  }

  drawOreCracks(ctx, ore) {
    const damage = 1 - ore.hp / ore.maxHp;
    if (damage < 0.18) return;
    ctx.globalAlpha = clamp(damage * 1.4, 0.3, 0.9);
    ctx.strokeStyle = '#151821';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-ore.radius * 0.1, -ore.radius * 0.72);
    ctx.lineTo(ore.radius * 0.04, -ore.radius * 0.2);
    ctx.lineTo(-ore.radius * 0.26, ore.radius * 0.16);
    if (damage > 0.45) {
      ctx.moveTo(ore.radius * 0.55, -ore.radius * 0.4);
      ctx.lineTo(ore.radius * 0.14, 0);
      ctx.lineTo(ore.radius * 0.48, ore.radius * 0.42);
    }
    if (damage > 0.72) {
      ctx.moveTo(-ore.radius * 0.6, ore.radius * 0.34);
      ctx.lineTo(-ore.radius * 0.18, ore.radius * 0.1);
      ctx.lineTo(ore.radius * 0.02, ore.radius * 0.7);
    }
    ctx.stroke();
  }

  drawEnemies(ctx) {
    for (const enemy of this.enemies) {
      if (!this.inView(enemy, 80)) continue;
      ctx.save();
      ctx.translate(enemy.x, enemy.y);
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath(); ctx.ellipse(0, enemy.radius * 0.72, enemy.radius * 0.9, enemy.radius * 0.34, 0, 0, TAU); ctx.fill();
      const squish = enemy.type === 'slime' ? Math.sin(enemy.phase * 1.6) * 0.08 : 0;
      ctx.scale(1 + squish, 1 - squish);
      ctx.fillStyle = enemy.hitFlash > 0 ? '#ffffff' : enemy.color;
      ctx.strokeStyle = enemy.isBoss ? CONFIG.colors.bossEdge : CONFIG.colors.enemyEdge;
      ctx.lineWidth = enemy.isBoss ? 7 : 4;

      if (enemy.type === 'crawler') {
        for (const side of [-1, 1]) {
          for (let leg = -1; leg <= 1; leg += 1) {
            ctx.beginPath();
            ctx.moveTo(side * enemy.radius * 0.65, leg * enemy.radius * 0.32);
            ctx.lineTo(side * enemy.radius * 1.25, leg * enemy.radius * 0.55);
            ctx.stroke();
          }
        }
      }
      if (enemy.type === 'bat') {
        ctx.beginPath();
        ctx.ellipse(-enemy.radius * 0.72, 0, enemy.radius * 0.8, enemy.radius * 0.42, -0.32, 0, TAU);
        ctx.ellipse(enemy.radius * 0.72, 0, enemy.radius * 0.8, enemy.radius * 0.42, 0.32, 0, TAU);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, 0, enemy.radius, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#12141a';
      const eyeOffset = enemy.radius * 0.32;
      ctx.beginPath(); ctx.arc(-eyeOffset, -enemy.radius * 0.12, Math.max(3, enemy.radius * 0.11), 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(eyeOffset, -enemy.radius * 0.12, Math.max(3, enemy.radius * 0.11), 0, TAU); ctx.fill();
      if (enemy.isBoss) {
        ctx.strokeStyle = '#f9d76a';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-30, -45); ctx.lineTo(-12, -76); ctx.lineTo(0, -48); ctx.lineTo(14, -76); ctx.lineTo(32, -44);
        ctx.stroke();
      }
      ctx.restore();
      this.drawHealthBar(ctx, enemy, enemy.hp / enemy.maxHp, enemy.radius * 2.2, enemy.isBoss ? 9 : 5);
    }
  }

  drawPlayer(ctx) {
    const player = this.player;
    const movement = Math.hypot(player.vx, player.vy);
    const bob = player.dashTimer > 0 ? 0 : Math.sin(this.run.elapsed * 11) * Math.min(3, movement / 90);
    ctx.save();
    ctx.translate(player.x, player.y + bob);
    ctx.globalAlpha = player.invulnerable > 0 && Math.floor(player.invulnerable * 18) % 2 ? 0.45 : 1;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath(); ctx.ellipse(0, player.radius * 0.84, player.radius * 0.88, player.radius * 0.35, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = player.hitFlash > 0 ? '#ffffff' : CONFIG.colors.player;
    ctx.strokeStyle = player.dashTimer > 0 ? '#8be9ff' : CONFIG.colors.playerEdge;
    ctx.lineWidth = player.dashTimer > 0 ? 7 : 5;
    ctx.shadowColor = player.dashTimer > 0 ? '#70d9ff' : 'transparent';
    ctx.shadowBlur = player.dashTimer > 0 ? 20 : 0;
    ctx.beginPath(); ctx.arc(0, 0, player.radius, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#30343d';
    ctx.beginPath(); ctx.arc(0, -7, player.radius * 0.88, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#f5d142';
    ctx.fillRect(-player.radius, -10, player.radius * 2, 7);
    ctx.fillStyle = '#151821';
    ctx.beginPath(); ctx.arc(7, -1, 4, 0, TAU); ctx.fill();

    ctx.rotate(player.angle);
    const swing = player.swingTimer > 0 ? -0.7 + (0.16 - player.swingTimer) * 8 : -0.35;
    ctx.rotate(swing);
    ctx.strokeStyle = '#a96f3d';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(9, 4); ctx.lineTo(52, 4); ctx.stroke();
    ctx.strokeStyle = '#d6dae4';
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.moveTo(45, -10); ctx.lineTo(58, 2); ctx.lineTo(45, 14); ctx.stroke();
    ctx.restore();

    if (player.swingTimer > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245,209,66,0.45)';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(player.x, player.y, player.attackRange * 0.84, player.angle - 0.72, player.angle + 0.72);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawDrones(ctx) {
    for (let index = 0; index < this.player.droneCount; index += 1) {
      const point = this.dronePosition(index);
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.rotate(this.run.elapsed * 4 + index);
      ctx.fillStyle = '#8be9ff';
      ctx.strokeStyle = '#d9fbff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#65d8ff';
      ctx.shadowBlur = 14;
      polygon(ctx, 0, 0, 10, 4);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  drawPickups(ctx) {
    for (const pickup of this.pickups) {
      if (!this.inView(pickup, 30)) continue;
      ctx.save();
      ctx.translate(pickup.x, pickup.y);
      ctx.rotate(performance.now() / 500 + pickup.id);
      ctx.fillStyle = pickup.color;
      ctx.shadowColor = pickup.color;
      ctx.shadowBlur = 16;
      polygon(ctx, 0, 0, pickup.radius, pickup.type === 'crystal' ? 4 : 6);
      ctx.fill();
      ctx.restore();
    }
  }

  drawPortal(ctx) {
    if (!this.portal) return;
    const portal = this.portal;
    ctx.save();
    ctx.translate(portal.x, portal.y);
    ctx.rotate(portal.phase);
    ctx.strokeStyle = CONFIG.colors.portal;
    ctx.shadowColor = CONFIG.colors.portal;
    ctx.shadowBlur = 28;
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(0, 0, portal.radius, 0, TAU); ctx.stroke();
    ctx.rotate(-portal.phase * 2.3);
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, portal.radius * 0.68, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(92,141,255,0.14)';
    ctx.beginPath(); ctx.arc(0, 0, portal.radius * 0.85, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EXTRACTION LIFT', portal.x, portal.y + portal.radius + 28);
  }

  drawParticles(ctx) {
    for (const particle of this.particles) {
      ctx.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.fillStyle = particle.color;
      ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.radius, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawTracers(ctx) {
    for (const tracer of this.tracers) {
      const alpha = clamp(tracer.life / tracer.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = tracer.color;
      ctx.shadowColor = tracer.color;
      ctx.shadowBlur = 16;
      if (tracer.ring) {
        const progress = 1 - alpha;
        ctx.lineWidth = 8 * alpha + 2;
        ctx.beginPath();
        ctx.arc(tracer.x1, tracer.y1, tracer.radius * (0.45 + progress * 0.55), 0, TAU);
        ctx.stroke();
      } else {
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(tracer.x1, tracer.y1); ctx.lineTo(tracer.x2, tracer.y2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawFloaters(ctx) {
    ctx.textAlign = 'center';
    ctx.font = '800 16px system-ui, sans-serif';
    for (const floater of this.floaters) {
      ctx.globalAlpha = clamp(floater.life / floater.maxLife, 0, 1);
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, floater.x, floater.y);
    }
    ctx.globalAlpha = 1;
  }

  drawLighting(ctx) {
    const radius = 500 + this.player.droneCount * 20;
    const gradient = ctx.createRadialGradient(
      this.player.x,
      this.player.y,
      110,
      this.player.x,
      this.player.y,
      radius
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.48, 'rgba(0,0,0,0.05)');
    gradient.addColorStop(0.78, 'rgba(0,0,0,0.38)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.76)');
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(this.camera.x - 20, this.camera.y - 20, this.viewportWidth + 40, this.viewportHeight + 40);
    ctx.restore();
  }

  drawHealthBar(ctx, entity, fraction, width, height) {
    const y = entity.y - entity.radius - 17;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, entity.x - width / 2, y, width, height, height / 2);
    ctx.fill();
    ctx.fillStyle = entity.isBoss ? '#c65df2' : 'kind' in entity ? '#f5d142' : '#f05a6b';
    roundRect(ctx, entity.x - width / 2, y, width * clamp(fraction, 0, 1), height, height / 2);
    ctx.fill();
  }

  inView(entity, padding = 0) {
    return entity.x + padding >= this.camera.x &&
      entity.x - padding <= this.camera.x + this.viewportWidth &&
      entity.y + padding >= this.camera.y &&
      entity.y - padding <= this.camera.y + this.viewportHeight;
  }

  rectInView(rect, padding = 0) {
    return rect.x + rect.width / 2 + padding >= this.camera.x &&
      rect.x - rect.width / 2 - padding <= this.camera.x + this.viewportWidth &&
      rect.y + rect.height / 2 + padding >= this.camera.y &&
      rect.y - rect.height / 2 - padding <= this.camera.y + this.viewportHeight;
  }
}

function polygon(ctx, x, y, radius, sides) {
  ctx.beginPath();
  for (let index = 0; index < sides; index += 1) {
    const angle = -Math.PI / 2 + (index / sides) * TAU;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundRect(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, width, height, safeRadius);
  else {
    ctx.moveTo(x + safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
    ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
    ctx.arcTo(x, y + height, x, y, safeRadius);
    ctx.arcTo(x, y, x + width, y, safeRadius);
  }
}

function normalizeAngle(angle) {
  let value = angle;
  while (value > Math.PI) value -= TAU;
  while (value < -Math.PI) value += TAU;
  return value;
}
