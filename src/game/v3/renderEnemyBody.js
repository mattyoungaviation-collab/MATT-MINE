import { CONFIG } from '../config.js';
import { bossPhaseForHealth } from '../combat.js';
import { TAU, polygon } from './drawHelpers.js';
import { imageIsReady } from './visualAssets.js';

export function drawEnemyBody(ctx, enemy, visualAssets = {}) {
  ctx.globalAlpha = enemy.hidden ? 0.22 : 1;
  if (enemy.isBoss && imageIsReady(visualAssets.guardian)) {
    drawCinematicGuardian(ctx, enemy, visualAssets.guardian);
    return;
  }
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.filter = 'blur(2px)';
  ctx.beginPath(); ctx.ellipse(3, enemy.radius * 0.76, enemy.radius, enemy.radius * 0.38, 0, 0, TAU); ctx.fill();
  ctx.filter = 'none';
  const squish = enemy.type === 'slime' ? Math.sin(enemy.phase * 1.6) * 0.08 : 0;
  ctx.rotate(enemy.type === 'beetle' ? enemy.facing : 0);
  ctx.scale(1 + squish, 1 - squish);
  const body = ctx.createRadialGradient(
    -enemy.radius * 0.32,
    -enemy.radius * 0.38,
    2,
    0,
    0,
    enemy.radius * 1.15
  );
  body.addColorStop(0, enemy.hitFlash > 0 ? '#ffffff' : '#d7c8e5');
  body.addColorStop(0.24, enemy.hitFlash > 0 ? '#ffffff' : enemy.color);
  body.addColorStop(0.72, enemy.type === 'slime' ? '#244b3d' : '#272231');
  body.addColorStop(1, '#090a0f');
  ctx.fillStyle = body;
  ctx.strokeStyle = enemy.isBoss ? CONFIG.colors.bossEdge : enemy.type === 'beetle' ? '#b0f0c7' : CONFIG.colors.enemyEdge;
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
  if (enemy.type === 'beetle') {
    ctx.fillStyle = enemy.hitFlash > 0 ? '#ffffff' : '#397a59';
    ctx.beginPath(); ctx.ellipse(-3, 0, enemy.radius * 1.05, enemy.radius * 0.86, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#87d6a4';
    ctx.beginPath(); ctx.arc(enemy.radius * 0.55, 0, enemy.radius * 0.58, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#d2ffe0';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(enemy.radius * 0.72, 0, enemy.radius * 0.5, -1.15, 1.15); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(0, 0, enemy.radius, 0, TAU); ctx.fill(); ctx.stroke();
  }
  if (enemy.type === 'exploder') {
    const fusePulse = enemy.fuseTimer > 0 ? 12 + Math.sin(performance.now() / 45) * 8 : 8;
    ctx.fillStyle = '#fff1aa';
    ctx.shadowColor = '#ffb342';
    ctx.shadowBlur = fusePulse;
    ctx.beginPath(); ctx.arc(0, 0, enemy.radius * 0.36, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
  }
  if (enemy.type !== 'beetle') {
    ctx.fillStyle = enemy.type === 'exploder' ? '#ffdb7a' : '#e3f4ff';
    ctx.shadowColor = enemy.type === 'exploder' ? '#ff7b31' : '#8e4fd8';
    ctx.shadowBlur = 9;
    const eyeOffset = enemy.radius * 0.32;
    ctx.beginPath(); ctx.arc(-eyeOffset, -enemy.radius * 0.12, Math.max(3, enemy.radius * 0.11), 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(eyeOffset, -enemy.radius * 0.12, Math.max(3, enemy.radius * 0.11), 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.26;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-enemy.radius * 0.28, -enemy.radius * 0.38, enemy.radius * 0.28, enemy.radius * 0.14, -0.45, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = enemy.hidden ? 0.22 : 1;
  }
  if (enemy.isBoss) {
    const phase = bossPhaseForHealth(enemy.hp, enemy.maxHp);
    ctx.strokeStyle = phase === 3 ? '#50e3c2' : '#f9d76a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-30, -45); ctx.lineTo(-12, -76); ctx.lineTo(0, -48); ctx.lineTo(14, -76); ctx.lineTo(32, -44);
    ctx.stroke();
    if (phase === 3) {
      ctx.fillStyle = '#50e3c2';
      ctx.shadowColor = '#50e3c2';
      ctx.shadowBlur = 20;
      polygon(ctx, 0, 2, 15, 5); ctx.fill();
    }
  }
}

function drawCinematicGuardian(ctx, enemy, image) {
  const phase = bossPhaseForHealth(enemy.hp, enemy.maxHp);
  const pulse = 0.92 + Math.sin(performance.now() / (phase === 3 ? 95 : 170)) * 0.08;
  const size = enemy.radius * (phase === 3 ? 3.7 : 3.45);
  const lift = enemy.radius * 0.08;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.filter = 'blur(5px)';
  ctx.beginPath();
  ctx.ellipse(7, enemy.radius * 0.88, enemy.radius * 1.5, enemy.radius * 0.6, 0, 0, TAU);
  ctx.fill();
  ctx.filter = 'none';

  ctx.scale(pulse, pulse);
  ctx.shadowColor = phase === 3 ? '#65f5ff' : '#9f45ed';
  ctx.shadowBlur = phase === 3 ? 34 : 24;
  ctx.globalAlpha = enemy.hitFlash > 0 ? 0.58 : 1;
  ctx.drawImage(image, -size / 2, -size / 2 - lift, size, size);
  ctx.globalAlpha = 1;

  if (enemy.hitFlash > 0) {
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.7;
    ctx.drawImage(image, -size / 2, -size / 2 - lift, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  const core = ctx.createRadialGradient(0, -enemy.radius * 0.18, 0, 0, -enemy.radius * 0.18, enemy.radius * 0.7);
  core.addColorStop(0, phase === 3 ? 'rgba(126,255,255,0.56)' : 'rgba(229,165,255,0.42)');
  core.addColorStop(0.3, phase === 3 ? 'rgba(50,227,194,0.2)' : 'rgba(146,57,221,0.14)');
  core.addColorStop(1, 'rgba(90,20,150,0)');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = core;
  ctx.fillRect(-enemy.radius, -enemy.radius * 1.2, enemy.radius * 2, enemy.radius * 2);
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}
