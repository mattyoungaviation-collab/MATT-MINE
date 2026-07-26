import { TAU, roundRect } from './drawHelpers.js';
import { imageIsReady } from './visualAssets.js';

const MATT_DYNO_FRAME_COUNT = 6;
const MATT_DYNO_WALK_FRAMES = 4;

export const renderPlayerMethods = {
  drawPlayer(ctx) {
    const player = this.player;
    const cosmetics = this.cosmetics || {};
    const movement = Math.hypot(player.vx, player.vy);
    const stride = player.dashTimer > 0 ? 0 : Math.sin(this.run.elapsed * 13) * Math.min(5, movement / 60);
    const facing = Math.cos(player.angle) >= 0 ? 1 : -1;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.globalAlpha = player.invulnerable > 0 && Math.floor(player.invulnerable * 18) % 2 ? 0.45 : 1;

    if (cosmetics.aura === 'guardian_aura') {
      const pulse = 1 + Math.sin(this.run.elapsed * 4) * 0.08;
      ctx.save();
      ctx.scale(pulse, pulse);
      ctx.strokeStyle = 'rgba(139, 233, 255, 0.72)';
      ctx.fillStyle = 'rgba(92, 141, 255, 0.12)';
      ctx.shadowColor = '#70d9ff';
      ctx.shadowBlur = 22;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 2, 35, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.filter = 'blur(2px)';
    ctx.beginPath(); ctx.ellipse(3, 24, 27, 10, 0, 0, TAU); ctx.fill();
    ctx.filter = 'none';

    const mattDyno = this.visualAssets?.mattDyno;
    if (imageIsReady(mattDyno)) {
      const moving = movement > 22;
      const frame = player.swingTimer > 0
        ? 5
        : moving
          ? 1 + Math.floor(this.run.elapsed * (player.dashTimer > 0 ? 14 : 8)) % MATT_DYNO_WALK_FRAMES
          : 0;
      const frameWidth = mattDyno.naturalWidth / MATT_DYNO_FRAME_COUNT;
      const breathing = moving ? 1 : 1 + Math.sin(this.run.elapsed * 3.4) * 0.018;
      const stepBob = moving
        ? Math.abs(Math.sin(this.run.elapsed * (player.dashTimer > 0 ? 14 : 8) * Math.PI)) * 2.2
        : Math.sin(this.run.elapsed * 3.4) * 1.1;
      const facesRight = Math.cos(player.angle) >= 0;

      ctx.save();
      ctx.translate(0, -stepBob);
      ctx.scale(facesRight ? -breathing : breathing, breathing);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = player.hitFlash > 0
        ? 'sepia(1) saturate(8) hue-rotate(310deg) brightness(1.2)'
        : cosmetics.skin === 'crystal_skin'
          ? 'hue-rotate(145deg) saturate(1.25) brightness(1.12) drop-shadow(0 0 8px rgba(112,217,255,.75))'
          : player.dashTimer > 0
            ? 'brightness(1.18) drop-shadow(0 0 9px rgba(112,217,255,.8))'
            : 'drop-shadow(0 3px 4px rgba(0,0,0,.78)) drop-shadow(0 0 2px rgba(245,209,66,.28))';
      ctx.drawImage(
        mattDyno,
        frame * frameWidth,
        0,
        frameWidth,
        mattDyno.naturalHeight,
        -63,
        -148,
        126,
        210
      );
      ctx.restore();
      ctx.restore();

      if (player.weapon === 'pickaxe' && player.swingTimer > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(245,209,66,0.5)';
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.attackRange * 0.84, player.angle - 0.72, player.angle + 0.72);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    ctx.strokeStyle = '#181b23';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-8, 12); ctx.lineTo(-11 + stride, 25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 12); ctx.lineTo(11 - stride, 25); ctx.stroke();
    ctx.strokeStyle = '#505565';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-9, 13); ctx.lineTo(-11 + stride, 22); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9, 13); ctx.lineTo(11 - stride, 22); ctx.stroke();

    const crystalSkin = cosmetics.skin === 'crystal_skin';
    ctx.fillStyle = '#222a35';
    ctx.strokeStyle = '#080a0f';
    ctx.lineWidth = 3;
    roundRect(ctx, -25, -10, 18, 32, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#50e3c2';
    ctx.shadowColor = '#37d7e8';
    ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(-20, 7, 3.5, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;

    const coat = ctx.createLinearGradient(-18, -14, 20, 24);
    if (crystalSkin) {
      coat.addColorStop(0, '#d9fbff');
      coat.addColorStop(0.3, '#62e8ff');
      coat.addColorStop(1, '#17638a');
    } else {
      coat.addColorStop(0, '#d98732');
      coat.addColorStop(0.38, '#8b431e');
      coat.addColorStop(0.62, '#27303a');
      coat.addColorStop(1, '#11151c');
    }
    ctx.fillStyle = player.hitFlash > 0 ? '#ff304e' : coat;
    ctx.strokeStyle = player.dashTimer > 0 ? '#8be9ff' : crystalSkin ? '#d8fbff' : '#6d421e';
    ctx.lineWidth = player.dashTimer > 0 ? 7 : 3;
    ctx.shadowColor = player.dashTimer > 0 || crystalSkin ? '#70d9ff' : 'transparent';
    ctx.shadowBlur = player.dashTimer > 0 ? 20 : crystalSkin ? 14 : 0;
    roundRect(ctx, -19, -13, 38, 39, 11); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = crystalSkin ? 'rgba(220,253,255,0.72)' : '#171b23';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-13, -6); ctx.lineTo(12, 18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(13, -6); ctx.lineTo(-12, 18); ctx.stroke();
    ctx.fillStyle = crystalSkin ? '#a9f4ff' : '#bb6b2b';
    roundRect(ctx, -16, 13, 32, 7, 3); ctx.fill();
    ctx.fillStyle = '#151821';
    ctx.fillRect(-3, 13, 6, 7);

    ctx.fillStyle = '#efb684';
    ctx.beginPath(); ctx.arc(0, -18, 15, 0, TAU); ctx.fill();
    const helmet = ctx.createLinearGradient(-18, -35, 18, -13);
    helmet.addColorStop(0, crystalSkin ? '#e5fdff' : '#f2a943');
    helmet.addColorStop(0.35, crystalSkin ? '#78e9ff' : '#a75b22');
    helmet.addColorStop(1, '#242936');
    ctx.fillStyle = helmet;
    ctx.strokeStyle = '#11141a';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, -22, 17, Math.PI, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = crystalSkin ? '#8be9ff' : '#d9852d';
    roundRect(ctx, -19, -25, 38, 7, 3); ctx.fill();
    ctx.fillStyle = '#eef7ff';
    ctx.shadowColor = '#8be9ff';
    ctx.shadowBlur = 11;
    ctx.beginPath(); ctx.arc(7 * facing, -27, 4.2, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#151821';
    ctx.beginPath(); ctx.arc(6 * facing, -18, 2.8, 0, TAU); ctx.fill();
    ctx.fillStyle = '#3a250f';
    ctx.fillRect(-6 * facing, -9, 12 * facing, 3);

    ctx.rotate(player.angle);
    if (player.weapon === 'blaster') {
      ctx.fillStyle = '#263347';
      ctx.strokeStyle = '#8be9ff';
      ctx.lineWidth = 4;
      roundRect(ctx, 10, -8, 45, 16, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#50e3c2';
      ctx.beginPath(); ctx.arc(50, 0, 5, 0, TAU); ctx.fill();
    } else if (player.weapon === 'dynamite') {
      ctx.fillStyle = '#b72d34';
      ctx.strokeStyle = '#ffcf73';
      ctx.lineWidth = 3;
      roundRect(ctx, 18, -8, 28, 16, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffb342';
      ctx.beginPath(); ctx.arc(47, -8, 4, 0, TAU); ctx.fill();
    } else {
      const swing = player.swingTimer > 0 ? -0.7 + (0.16 - player.swingTimer) * 8 : -0.35;
      const molten = cosmetics.weapon === 'molten_pickaxe';
      ctx.rotate(swing);
      ctx.strokeStyle = molten ? '#7d351e' : '#a96f3d';
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(9, 4); ctx.lineTo(52, 4); ctx.stroke();
      ctx.strokeStyle = molten ? '#ff8a3d' : '#d6dae4';
      ctx.shadowColor = molten ? '#ff5a24' : 'transparent';
      ctx.shadowBlur = molten ? 18 : 0;
      ctx.lineWidth = 10;
      ctx.beginPath(); ctx.moveTo(45, -10); ctx.lineTo(58, 2); ctx.lineTo(45, 14); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    if (player.weapon === 'pickaxe' && player.swingTimer > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245,209,66,0.45)';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(player.x, player.y, player.attackRange * 0.84, player.angle - 0.72, player.angle + 0.72);
      ctx.stroke();
      ctx.restore();
    }
  }
};
