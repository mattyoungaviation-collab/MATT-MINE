import { CONFIG } from '../config.js';
import { bossPhaseForHealth } from '../combat.js';
import { TAU, polygon } from './drawHelpers.js';

export function drawEnemyBody(ctx, enemy) {
  ctx.globalAlpha = enemy.hidden ? 0.22 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(0, enemy.radius * 0.72, enemy.radius * 0.9, enemy.radius * 0.34, 0, 0, TAU); ctx.fill();
  const squish = enemy.type === 'slime' ? Math.sin(enemy.phase * 1.6) * 0.08 : 0;
  ctx.rotate(enemy.type === 'beetle' ? enemy.facing : 0);
  ctx.scale(1 + squish, 1 - squish);
  ctx.fillStyle = enemy.hitFlash > 0 ? '#ffffff' : enemy.color;
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
    ctx.fillStyle = '#12141a';
    const eyeOffset = enemy.radius * 0.32;
    ctx.beginPath(); ctx.arc(-eyeOffset, -enemy.radius * 0.12, Math.max(3, enemy.radius * 0.11), 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(eyeOffset, -enemy.radius * 0.12, Math.max(3, enemy.radius * 0.11), 0, TAU); ctx.fill();
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
