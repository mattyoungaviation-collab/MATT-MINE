import { TAU, roundRect } from './drawHelpers.js';

export const renderProjectileMethods = {
  drawProjectiles(ctx) {
    for (const projectile of this.projectiles) {
      if (!this.inView(projectile, 40)) continue;
      ctx.save();
      ctx.translate(projectile.x, projectile.y);
      if (projectile.kind === 'dynamite') {
        ctx.rotate(performance.now() / 90);
        ctx.fillStyle = '#b72d34';
        ctx.strokeStyle = '#ffcf73';
        ctx.lineWidth = 3;
        roundRect(ctx, -11, -7, 22, 14, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = Math.floor(projectile.life * 12) % 2 ? '#ffffff' : '#ffb342';
        ctx.beginPath(); ctx.arc(11, -8, 4, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = projectile.color;
        ctx.shadowColor = projectile.color;
        ctx.shadowBlur = 18;
        ctx.beginPath(); ctx.arc(0, 0, projectile.radius, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.45;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-projectile.vx * 0.035, -projectile.vy * 0.035); ctx.strokeStyle = projectile.color; ctx.lineWidth = projectile.radius; ctx.stroke();
      }
      ctx.restore();
    }
  }
};
