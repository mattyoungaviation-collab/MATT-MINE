import { TAU, roundRect } from './drawHelpers.js';

export const renderPlayerMethods = {
  drawPlayer(ctx) {
    const player = this.player;
    const movement = Math.hypot(player.vx, player.vy);
    const stride = player.dashTimer > 0 ? 0 : Math.sin(this.run.elapsed * 13) * Math.min(5, movement / 60);
    const facing = Math.cos(player.angle) >= 0 ? 1 : -1;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.globalAlpha = player.invulnerable > 0 && Math.floor(player.invulnerable * 18) % 2 ? 0.45 : 1;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath(); ctx.ellipse(0, 22, 24, 9, 0, 0, TAU); ctx.fill();

    ctx.strokeStyle = '#2f3440';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-8, 12); ctx.lineTo(-11 + stride, 25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 12); ctx.lineTo(11 - stride, 25); ctx.stroke();

    ctx.fillStyle = player.hitFlash > 0 ? '#ffffff' : '#f5d142';
    ctx.strokeStyle = player.dashTimer > 0 ? '#8be9ff' : '#fff2a0';
    ctx.lineWidth = player.dashTimer > 0 ? 7 : 4;
    ctx.shadowColor = player.dashTimer > 0 ? '#70d9ff' : 'transparent';
    ctx.shadowBlur = player.dashTimer > 0 ? 20 : 0;
    roundRect(ctx, -19, -13, 38, 38, 13); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#efb684';
    ctx.beginPath(); ctx.arc(0, -18, 15, 0, TAU); ctx.fill();
    ctx.fillStyle = '#30343d';
    ctx.beginPath(); ctx.arc(0, -22, 17, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#f5d142';
    ctx.fillRect(-18, -23, 36, 6);
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
      ctx.rotate(swing);
      ctx.strokeStyle = '#a96f3d';
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(9, 4); ctx.lineTo(52, 4); ctx.stroke();
      ctx.strokeStyle = '#d6dae4';
      ctx.lineWidth = 10;
      ctx.beginPath(); ctx.moveTo(45, -10); ctx.lineTo(58, 2); ctx.lineTo(45, 14); ctx.stroke();
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
