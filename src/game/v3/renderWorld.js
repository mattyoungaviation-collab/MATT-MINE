import { CONFIG } from '../config.js';
import { clamp } from '../utils.js';
import { TAU, polygon, roundRect } from './drawHelpers.js';
import { imageIsReady } from './visualAssets.js';

const ROOM_TINTS = Object.freeze({
  start: 'rgba(25,38,54,0.34)',
  mining: 'rgba(16,47,41,0.28)',
  combat: 'rgba(72,21,27,0.28)',
  mixed: 'rgba(27,27,38,0.22)',
  treasure: 'rgba(57,29,84,0.3)',
  guardian: 'rgba(73,20,90,0.34)'
});

export const renderWorldMethods = {
  drawWorld(ctx) {
    const backdrop = ctx.createLinearGradient(
      this.camera.x,
      this.camera.y,
      this.camera.x,
      this.camera.y + this.viewportHeight
    );
    backdrop.addColorStop(0, '#05060a');
    backdrop.addColorStop(0.55, '#090811');
    backdrop.addColorStop(1, '#030407');
    ctx.fillStyle = backdrop;
    ctx.fillRect(this.camera.x - 30, this.camera.y - 30, this.viewportWidth + 60, this.viewportHeight + 60);
    if (!this.layout) return;

    for (const corridor of this.layout.corridors) {
      if (!this.rectInView(corridor, 80)) continue;
      this.drawFloorRect(ctx, corridor, '#0d0f14', 18);
      this.drawCinematicFloor(ctx, corridor, 'rgba(22,20,28,0.42)', 18, 0.66);
    }

    for (const room of this.layout.rooms) {
      if (!this.rectInView(room, 100)) continue;
      this.drawFloorRect(ctx, room, '#11131a', 26);
      this.drawCinematicFloor(ctx, room, ROOM_TINTS[room.type] || ROOM_TINTS.mixed, 26, 0.88);
      this.drawRoomStoneEdge(ctx, room);
      this.drawRoomGrid(ctx, room);
      this.drawRoomTorches(ctx, room);

      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#d8d3e8';
      ctx.font = '900 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.letterSpacing = '0.12em';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 8;
      ctx.fillText(room.name.toUpperCase(), room.x, room.y - room.height / 2 + 35);
      ctx.restore();
    }

    this.drawRoomGates(ctx);
    this.drawCompetitionHazards(ctx);

    for (const rock of this.decor) {
      if (!this.inView(rock, 30)) continue;
      ctx.save();
      ctx.translate(rock.x, rock.y);
      ctx.rotate(rock.rotation);
      const stone = ctx.createLinearGradient(-rock.radius, -rock.radius, rock.radius, rock.radius);
      stone.addColorStop(0, `rgba(99,101,116,${rock.alpha + 0.08})`);
      stone.addColorStop(0.48, `rgba(28,30,39,${Math.min(0.72, rock.alpha + 0.28)})`);
      stone.addColorStop(1, `rgba(3,4,8,${Math.min(0.86, rock.alpha + 0.42)})`);
      ctx.fillStyle = stone;
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.ellipse(0, 0, rock.radius, rock.radius * 0.58, 0, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(171,158,194,0.1)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-rock.radius * 0.65, -rock.radius * 0.08);
      ctx.lineTo(-rock.radius * 0.1, -rock.radius * 0.3);
      ctx.lineTo(rock.radius * 0.55, rock.radius * 0.02);
      ctx.stroke();
      ctx.restore();
    }
  },

  drawCompetitionHazards(ctx) {
    for (const hazard of this.hazards || []) {
      if (!this.inView(hazard, 90)) continue;
      const pulse = 0.55 + Math.sin((hazard.phase || 0) * 5) * 0.15;
      ctx.save();
      ctx.translate(hazard.x, hazard.y);
      if (hazard.type === 'crystal_field') {
        ctx.fillStyle = `rgba(87,218,255,${0.14 + pulse * 0.12})`;
        ctx.strokeStyle = 'rgba(156,239,255,0.78)';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#56dfff';
        ctx.shadowBlur = 24;
        for (let index = 0; index < 7; index += 1) {
          const angle = (index / 7) * TAU;
          polygon(ctx, Math.cos(angle) * 29, Math.sin(angle) * 23, 12 + index % 3 * 3, 5);
          ctx.fill();
          ctx.stroke();
        }
      } else {
        const active = (hazard.phase || 0) % 2.8 > 2.05;
        ctx.fillStyle = active ? 'rgba(255,79,50,0.32)' : `rgba(255,179,66,${0.08 + pulse * 0.08})`;
        ctx.strokeStyle = active ? '#ff5d42' : 'rgba(255,199,92,0.62)';
        ctx.lineWidth = active ? 5 : 2;
        ctx.setLineDash(active ? [] : [10, 9]);
        ctx.beginPath();
        ctx.arc(0, 0, hazard.radius, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#d5c6aa';
        for (let index = 0; index < 5; index += 1) {
          polygon(ctx, Math.cos(index * 2.1) * 31, Math.sin(index * 1.7) * 25, 8 + index % 2 * 4, 6);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  },

  drawCinematicFloor(ctx, rect, tint, radius, alpha) {
    const x = rect.x - rect.width / 2;
    const y = rect.y - rect.height / 2;
    ctx.save();
    roundRect(ctx, x + 7, y + 7, rect.width - 14, rect.height - 14, Math.max(4, radius - 7));
    ctx.clip();
    const floor = this.visualAssets?.floor;
    if (imageIsReady(floor)) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(floor, x, y, rect.width, rect.height);
    } else {
      const fallback = ctx.createLinearGradient(x, y, x + rect.width, y + rect.height);
      fallback.addColorStop(0, '#24242d');
      fallback.addColorStop(0.5, '#101218');
      fallback.addColorStop(1, '#1d1722');
      ctx.fillStyle = fallback;
      ctx.fillRect(x, y, rect.width, rect.height);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, rect.width, rect.height);
    const soot = ctx.createRadialGradient(rect.x, rect.y, 20, rect.x, rect.y, Math.max(rect.width, rect.height) * 0.68);
    soot.addColorStop(0, 'rgba(0,0,0,0)');
    soot.addColorStop(0.72, 'rgba(0,0,0,0.08)');
    soot.addColorStop(1, 'rgba(0,0,0,0.58)');
    ctx.fillStyle = soot;
    ctx.fillRect(x, y, rect.width, rect.height);
    ctx.restore();
  },

  drawRoomStoneEdge(ctx, room) {
    const x = room.x - room.width / 2;
    const y = room.y - room.height / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.74)';
    ctx.lineWidth = 28;
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 24;
    roundRect(ctx, x, y, room.width, room.height, 26);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = room.type === 'guardian' ? 'rgba(147,70,224,0.38)' : 'rgba(114,107,126,0.22)';
    ctx.lineWidth = 4;
    roundRect(ctx, x + 3, y + 3, room.width - 6, room.height - 6, 23);
    ctx.stroke();
    ctx.restore();
  },

  drawRoomGrid(ctx, room) {
    const left = room.x - room.width / 2 + 26;
    const right = room.x + room.width / 2 - 26;
    const top = room.y - room.height / 2 + 26;
    const bottom = room.y + room.height / 2 - 26;
    ctx.save();
    ctx.strokeStyle = 'rgba(167,148,113,0.08)';
    ctx.lineWidth = 2;
    for (let x = left + CONFIG.gridSize; x < right; x += CONFIG.gridSize * 2) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x + Math.sin(x + room.id) * 5, bottom);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    for (let y = top + CONFIG.gridSize; y < bottom; y += CONFIG.gridSize * 2) {
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y + Math.cos(y + room.id) * 4);
      ctx.stroke();
    }
    ctx.restore();
  },

  drawRoomTorches(ctx, room) {
    const pulse = 0.84 + Math.sin(performance.now() / 175 + room.id) * 0.1;
    for (const side of [-1, 1]) {
      const x = room.x + side * (room.width / 2 - 34);
      const y = room.y - room.height / 2 + 42;
      ctx.save();
      const halo = ctx.createRadialGradient(x, y, 2, x, y, 82 * pulse);
      halo.addColorStop(0, 'rgba(255,226,145,0.52)');
      halo.addColorStop(0.18, 'rgba(255,151,46,0.22)');
      halo.addColorStop(1, 'rgba(255,103,27,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(x - 90, y - 90, 180, 180);
      ctx.translate(x, y);
      ctx.fillStyle = '#25212a';
      ctx.strokeStyle = '#a06b34';
      ctx.lineWidth = 2;
      roundRect(ctx, -8, -11, 16, 25, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffd88b';
      ctx.shadowColor = '#ff8d2e';
      ctx.shadowBlur = 22 * pulse;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.quadraticCurveTo(10, 2, 0, 11);
      ctx.quadraticCurveTo(-9, 2, 0, -9);
      ctx.fill();
      ctx.restore();
    }
  },

  drawOres(ctx) {
    for (const ore of this.ores) {
      if (!this.inView(ore, 60)) continue;
      ctx.save();
      ctx.translate(ore.x, ore.y);
      ctx.rotate(ore.rotation);
      const glow = ore.kind === 'crystal' || ore.rich;
      const pulse = 0.85 + Math.sin(performance.now() / 230 + ore.id) * 0.15;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.ellipse(3, ore.radius * 0.55, ore.radius * 1.15, ore.radius * 0.46, 0, 0, TAU);
      ctx.fill();

      if (ore.kind === 'cache') {
        const chest = ctx.createLinearGradient(-ore.radius, -ore.radius, ore.radius, ore.radius);
        chest.addColorStop(0, '#7c4b21');
        chest.addColorStop(0.45, '#352217');
        chest.addColorStop(1, '#120d0b');
        ctx.fillStyle = ore.hitFlash > 0 ? '#ffffff' : chest;
        ctx.strokeStyle = '#c79344';
        ctx.lineWidth = 4;
        roundRect(ctx, -ore.radius * 1.1, -ore.radius * 0.8, ore.radius * 2.2, ore.radius * 1.6, 7);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f3c152';
        ctx.fillRect(-4, -ore.radius * 0.26, 8, ore.radius * 0.52);
      } else {
        if (glow) {
          ctx.shadowColor = ore.color;
          ctx.shadowBlur = (22 + Math.sin(performance.now() / 220 + ore.id) * 6) * pulse;
        }
        const mineral = ctx.createLinearGradient(-ore.radius, -ore.radius, ore.radius, ore.radius);
        mineral.addColorStop(0, ore.hitFlash > 0 ? '#ffffff' : '#f0eaff');
        mineral.addColorStop(0.18, ore.hitFlash > 0 ? '#ffffff' : ore.color);
        mineral.addColorStop(0.7, ore.kind === 'crystal' ? '#512079' : '#3b3332');
        mineral.addColorStop(1, '#111118');
        ctx.fillStyle = mineral;
        ctx.strokeStyle = glow ? 'rgba(232,202,255,0.72)' : 'rgba(7,7,10,0.88)';
        ctx.lineWidth = glow ? 3 : 5;
        polygon(ctx, 0, 2, ore.radius, ore.kind === 'crystal' ? 5 : 7);
        ctx.fill();
        ctx.stroke();
        if (ore.kind === 'crystal') {
          for (const shard of [-0.52, 0.48]) {
            ctx.save();
            ctx.translate(shard * ore.radius, ore.radius * 0.24);
            ctx.rotate(shard * 0.72);
            ctx.globalAlpha = 0.85;
            polygon(ctx, 0, 0, ore.radius * 0.62, 5);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#ffffff';
        polygon(ctx, -ore.radius * 0.2, -ore.radius * 0.28, ore.radius * 0.34, 5);
        ctx.fill();
      }
      this.drawOreCracks(ctx, ore);
      ctx.restore();
      if (ore.hp < ore.maxHp) this.drawHealthBar(ctx, ore, ore.hp / ore.maxHp, ore.radius * 1.9, 5);
    }
  },

  drawLighting(ctx) {
    const radius = 470 + this.player.droneCount * 22;
    const darkness = ctx.createRadialGradient(
      this.player.x,
      this.player.y,
      105,
      this.player.x,
      this.player.y,
      radius
    );
    darkness.addColorStop(0, 'rgba(0,0,0,0)');
    darkness.addColorStop(0.46, 'rgba(2,2,6,0.04)');
    darkness.addColorStop(0.76, 'rgba(2,2,7,0.46)');
    darkness.addColorStop(1, 'rgba(0,0,3,0.86)');
    ctx.save();
    ctx.fillStyle = darkness;
    ctx.fillRect(this.camera.x - 20, this.camera.y - 20, this.viewportWidth + 40, this.viewportHeight + 40);

    ctx.globalCompositeOperation = 'screen';
    const playerLight = ctx.createRadialGradient(
      this.player.x - 10,
      this.player.y - 12,
      0,
      this.player.x,
      this.player.y,
      165
    );
    playerLight.addColorStop(0, 'rgba(255,188,78,0.26)');
    playerLight.addColorStop(0.35, 'rgba(255,118,39,0.08)');
    playerLight.addColorStop(1, 'rgba(255,92,26,0)');
    ctx.fillStyle = playerLight;
    ctx.fillRect(this.player.x - 180, this.player.y - 180, 360, 360);

    for (const ore of this.ores) {
      if (ore.kind !== 'crystal' || !this.inView(ore, 100)) continue;
      const crystalLight = ctx.createRadialGradient(ore.x, ore.y, 0, ore.x, ore.y, ore.rich ? 95 : 65);
      crystalLight.addColorStop(0, 'rgba(171,78,255,0.27)');
      crystalLight.addColorStop(0.34, 'rgba(122,38,222,0.12)');
      crystalLight.addColorStop(1, 'rgba(80,19,160,0)');
      ctx.fillStyle = crystalLight;
      ctx.fillRect(ore.x - 100, ore.y - 100, 200, 200);
    }

    const boss = this.enemies.find((enemy) => enemy.isBoss && !enemy.hidden && this.inView(enemy, 200));
    if (boss) {
      const bossLight = ctx.createRadialGradient(boss.x, boss.y, 5, boss.x, boss.y, 210);
      bossLight.addColorStop(0, 'rgba(180,75,255,0.34)');
      bossLight.addColorStop(0.38, 'rgba(108,33,185,0.16)');
      bossLight.addColorStop(1, 'rgba(65,13,112,0)');
      ctx.fillStyle = bossLight;
      ctx.fillRect(boss.x - 220, boss.y - 220, 440, 440);
    }
    ctx.globalCompositeOperation = 'source-over';
    this.drawCaveAtmosphere(ctx);
    ctx.restore();
  },

  drawCaveAtmosphere(ctx) {
    const time = this.run?.elapsed || 0;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let index = 0; index < 34; index += 1) {
      const seedX = ((index * 191.7) % (this.viewportWidth + 120)) - 60;
      const seedY = ((index * 83.3) % (this.viewportHeight + 120)) - 60;
      const drift = Math.sin(time * 0.23 + index * 1.7) * 18;
      const x = this.camera.x + seedX + drift;
      const y = this.camera.y + seedY - ((time * (4 + index % 3)) % 80);
      const alpha = 0.025 + (index % 5) * 0.008;
      ctx.fillStyle = index % 7 === 0 ? `rgba(184,104,255,${alpha * 1.7})` : `rgba(255,202,132,${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + (index % 3) * 0.55, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  },

  drawRoomGates(ctx) {
    if (!this.activeLockedRoomId) return;
    const room = this.layout.rooms.find((entry) => entry.id === this.activeLockedRoomId);
    if (!room) return;
    const pulse = 0.65 + Math.sin(performance.now() / 110) * 0.25;
    const gates = [
      { x: room.x, y: room.y - room.height / 2, width: 108, height: 15 },
      { x: room.x, y: room.y + room.height / 2, width: 108, height: 15 },
      { x: room.x - room.width / 2, y: room.y, width: 15, height: 108 },
      { x: room.x + room.width / 2, y: room.y, width: 15, height: 108 }
    ];
    for (const gate of gates) {
      ctx.save();
      const energy = ctx.createLinearGradient(
        gate.x - gate.width / 2,
        gate.y - gate.height / 2,
        gate.x + gate.width / 2,
        gate.y + gate.height / 2
      );
      energy.addColorStop(0, `rgba(255,51,82,${pulse})`);
      energy.addColorStop(0.5, `rgba(255,160,95,${clamp(pulse + 0.16, 0, 1)})`);
      energy.addColorStop(1, `rgba(168,24,83,${pulse})`);
      ctx.fillStyle = energy;
      ctx.shadowColor = '#ef5367';
      ctx.shadowBlur = 28;
      roundRect(ctx, gate.x - gate.width / 2, gate.y - gate.height / 2, gate.width, gate.height, 7);
      ctx.fill();
      ctx.restore();
    }
  }
};
