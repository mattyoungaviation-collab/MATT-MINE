import { TAU, roundRect } from './drawHelpers.js';
import { imageIsReady } from './visualAssets.js';

const MATT_DYNO_WALK_FRAMES = 4;
const MATT_DYNO_FRAME_WIDTH = 120;
const MATT_DYNO_FRAME_HEIGHT = 241;
const MATT_DYNO_SHEET_EDGE = 2;
const MATT_DYNO_DRAW_WIDTH = 108;
const MATT_DYNO_DRAW_HEIGHT = 180;

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

    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.beginPath(); ctx.ellipse(3, 23, 29, 11, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.46)';
    ctx.beginPath(); ctx.ellipse(3, 23, 21, 7, 0, 0, TAU); ctx.fill();

    const sideAssets = {
      pickaxe: this.visualAssets?.mattDyno,
      blaster: this.visualAssets?.mattDynoBlaster,
      dynamite: this.visualAssets?.mattDynoDynamite
    };
    const verticalAssets = {
      pickaxe: this.visualAssets?.mattDynoPickaxeVertical,
      blaster: this.visualAssets?.mattDynoBlasterVertical,
      dynamite: this.visualAssets?.mattDynoDynamiteVertical
    };
    const moving = movement > 22;
    const visualAngle = player.swingTimer > 0 || !moving
      ? player.angle
      : Math.atan2(player.vy, player.vx);
    const verticalFacing = Math.abs(Math.sin(visualAngle)) > Math.abs(Math.cos(visualAngle));
    const requestedAsset = verticalFacing
      ? verticalAssets[player.weapon]
      : sideAssets[player.weapon];
    const mattDyno = imageIsReady(requestedAsset)
      ? requestedAsset
      : sideAssets.pickaxe;
    if (imageIsReady(mattDyno)) {
      const attacking = player.swingTimer > 0;
      const frame = attacking
        ? 5
        : moving
          ? 1 + Math.floor(this.run.elapsed * (player.dashTimer > 0 ? 14 : 8)) % MATT_DYNO_WALK_FRAMES
          : 0;
      const usesVerticalSheet = verticalFacing && mattDyno === verticalAssets[player.weapon];
      const frameWidth = Math.min(MATT_DYNO_FRAME_WIDTH, mattDyno.naturalWidth);
      const frameHeight = Math.min(MATT_DYNO_FRAME_HEIGHT, usesVerticalSheet
        ? mattDyno.naturalHeight / 2
        : mattDyno.naturalHeight);
      const frameRow = usesVerticalSheet && Math.sin(visualAngle) < 0 ? 1 : 0;
      const breathing = moving ? 1 : 1 + Math.sin(this.run.elapsed * 3.4) * 0.018;
      const stepBob = moving
        ? Math.abs(Math.sin(this.run.elapsed * (player.dashTimer > 0 ? 14 : 8) * Math.PI)) * 2.2
        : Math.sin(this.run.elapsed * 3.4) * 1.1;
      const facesRight = Math.cos(visualAngle) >= 0;
      const actionDuration = player.weapon === 'dynamite' ? 0.24 : player.weapon === 'blaster' ? 0.14 : 0.16;
      const actionProgress = attacking
        ? Math.max(0, Math.min(1, 1 - player.swingTimer / actionDuration))
        : 0;
      const actionLunge = attacking ? Math.sin(actionProgress * Math.PI) * 5 : 0;
      const actionTilt = attacking && !usesVerticalSheet
        ? Math.sin(actionProgress * Math.PI) * (facesRight ? -0.08 : 0.08)
        : 0;

      ctx.save();
      ctx.translate(
        Math.cos(visualAngle) * actionLunge,
        -stepBob + Math.sin(visualAngle) * actionLunge
      );
      ctx.rotate(actionTilt);
      ctx.scale(!usesVerticalSheet && facesRight ? -breathing : breathing, breathing);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
      // Canvas filters are especially expensive on mobile GPUs. The new
      // sprites are pre-lit, so normal movement needs no live filter pass.
      ctx.filter = player.hitFlash > 0
        ? 'sepia(1) saturate(6) hue-rotate(310deg) brightness(1.15)'
        : cosmetics.skin === 'crystal_skin'
          ? 'hue-rotate(145deg) saturate(1.2) brightness(1.08)'
          : player.dashTimer > 0
            ? 'brightness(1.12)'
            : 'none';
      ctx.drawImage(
        mattDyno,
        Math.min(
          MATT_DYNO_SHEET_EDGE + frame * MATT_DYNO_FRAME_WIDTH,
          Math.max(0, mattDyno.naturalWidth - frameWidth)
        ),
        frameRow * frameHeight,
        frameWidth,
        frameHeight,
        -MATT_DYNO_DRAW_WIDTH / 2,
        -127,
        MATT_DYNO_DRAW_WIDTH,
        MATT_DYNO_DRAW_HEIGHT
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
