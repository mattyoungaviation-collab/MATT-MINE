import { CONFIG } from '../config.js';
import { pointInLayout, roomAt } from '../layout.js';
import { clamp } from '../utils.js';
import { roomRequiresLock } from '../combat.js';
import { nftGameplayTraits } from '../nftTraits.js';

export const roomsMethods = {
  awakenGuardian(room) {
    if (
      room?.type !== 'guardian' ||
      !this.run.bossReady ||
      this.run.bossSpawned
    ) return null;
    this.run.bossSpawned = true;
    const guardian = this.spawnEnemy(true, room);
    if (guardian) guardian.awake = true;
    this.hooks.onToast?.('THE GUARDIAN AWAKENS');
    return guardian;
  },
  moveEntity(entity, dx, dy) {
    const padding = Math.max(8, entity.radius * 0.68);
    let boundsRoom = null;
    if (entity === this.player && this.activeLockedRoomId) boundsRoom = this.layout.rooms.find((room) => room.id === this.activeLockedRoomId);
    else if (entity.isBoss) boundsRoom = this.layout.guardianRoom;
    else if (entity.roomId && this.roomStates?.[entity.roomId]?.locked) boundsRoom = this.layout.rooms.find((room) => room.id === entity.roomId);

    if (boundsRoom) {
      const halfWidth = boundsRoom.width / 2 - padding;
      const halfHeight = boundsRoom.height / 2 - padding;
      entity.x = clamp(entity.x + dx, boundsRoom.x - halfWidth, boundsRoom.x + halfWidth);
      entity.y = clamp(entity.y + dy, boundsRoom.y - halfHeight, boundsRoom.y + halfHeight);
      return;
    }

    const nextX = clamp(entity.x + dx, entity.radius, CONFIG.worldWidth - entity.radius);
    if (pointInLayout(this.layout, nextX, entity.y, padding)) entity.x = nextX;
    else if ('vx' in entity) entity.vx = 0;
    const nextY = clamp(entity.y + dy, entity.radius, CONFIG.worldHeight - entity.radius);
    if (pointInLayout(this.layout, entity.x, nextY, padding)) entity.y = nextY;
    else if ('vy' in entity) entity.vy = 0;
  },
  lockRoom(room) {
    const state = this.roomStates?.[room.id];
    if (!state || state.cleared || state.locked) return;
    if (room.type === 'guardian' && !this.run.bossSpawned) return;
    const hasRemainingEnemies = this.enemies.some((enemy) => enemy.roomId === room.id);
    if (!hasRemainingEnemies) {
      state.triggered = true;
      this.unlockRoom(room.id, true);
      return;
    }
    state.triggered = true;
    state.locked = true;
    this.activeLockedRoomId = room.id;
    for (const enemy of this.enemies.filter((entry) => entry.roomId === room.id)) {
      enemy.awake = true;
      enemy.hidden = enemy.type === 'crawler';
    }
    this.audio.play('roomLock');
    if (room.type === 'guardian') {
      this.audio.startBoss();
      this.hooks.onToast?.('GUARDIAN VAULT SEALED');
    } else {
      this.hooks.onToast?.(`${room.name}: doors sealed`);
    }
  },
  unlockRoom(roomId, grantReward = true) {
    const state = this.roomStates?.[roomId];
    if (!state) return;
    state.locked = false;
    state.cleared = true;
    if (this.activeLockedRoomId === roomId) this.activeLockedRoomId = null;
    if (!grantReward) return;
    const room = this.layout.rooms.find((entry) => entry.id === roomId);
    if (!this.player.unlockedWeapons.dynamite) this.unlockWeapon('dynamite', 3);
    else this.player.dynamiteAmmo += 2;
    const roomHeal = nftGameplayTraits(this.runContext) ? 0 : 12;
    if (roomHeal > 0) {
      this.player.health = Math.min(this.player.maxHealth, this.player.health + roomHeal);
    }
    this.audio.play('roomClear');
    this.addFloater(
      this.player.x,
      this.player.y - 52,
      roomHeal > 0 ? '+ DYNAMITE  + HEALTH' : '+ DYNAMITE',
      '#ffe083'
    );
    this.hooks.onToast?.(`${room?.name || 'Room'} cleared`);
  },
  checkRoomClear(roomId) {
    const state = this.roomStates?.[roomId];
    if (!state?.locked) return;
    const remaining = this.enemies.some((enemy) => enemy.roomId === roomId && enemy.awake);
    if (!remaining) this.unlockRoom(roomId, true);
  },
  updateCurrentRoom() {
    const room = roomAt(this.layout, this.player.x, this.player.y);
    if (!room) return;
    if (room.id !== this.lastRoomId) {
      this.lastRoomId = room.id;
      if (room.type !== 'start') this.hooks.onToast?.(room.name);
    }
    if (room.type === 'guardian') this.awakenGuardian(room);
    if (roomRequiresLock(room.type)) {
      const state = this.roomStates?.[room.id];
      if (state && !state.triggered && !state.cleared) this.lockRoom(room);
    }
  }
};
