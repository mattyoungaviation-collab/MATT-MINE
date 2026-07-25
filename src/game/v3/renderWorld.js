import { CONFIG } from '../config.js';
import { TAU, roundRect } from './drawHelpers.js';

export const renderWorldMethods = {
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

    this.drawRoomGates(ctx);

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
      ctx.fillStyle = `rgba(239,83,103,${pulse})`;
      ctx.shadowColor = '#ef5367';
      ctx.shadowBlur = 22;
      roundRect(ctx, gate.x - gate.width / 2, gate.y - gate.height / 2, gate.width, gate.height, 7);
      ctx.fill();
      ctx.restore();
    }
  }
};
