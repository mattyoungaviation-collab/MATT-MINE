import { clamp } from '../utils.js';
import { TAU } from './drawHelpers.js';

export const renderGoldTrailMethods = {
  drawGroundTrails(ctx) {
    const elapsed = this.run?.elapsed || 0;
    for (const particle of this.particles) {
      if (particle.layer !== 'ground') continue;
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      if (alpha <= 0) continue;

      if (particle.kind === 'gold_trail_glow') {
        drawGoldGlowSegment(ctx, particle, alpha);
      } else if (particle.kind === 'gold_trail_spark') {
        drawGoldSpark(ctx, particle, alpha, elapsed);
      }
    }
  },

  drawParticles(ctx) {
    for (const particle of this.particles) {
      if (particle.layer === 'ground') continue;
      ctx.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.radius, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
};

function drawGoldGlowSegment(ctx, particle, alpha) {
  const fade = alpha * alpha;
  const width = particle.radius * (0.86 + fade * 0.34);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  ctx.globalAlpha = fade * 0.22;
  ctx.strokeStyle = '#f2a91f';
  ctx.shadowColor = '#ffc83d';
  ctx.shadowBlur = 15;
  ctx.lineWidth = width * 3.2;
  ctx.beginPath();
  ctx.moveTo(particle.x1, particle.y1);
  ctx.lineTo(particle.x2, particle.y2);
  ctx.stroke();

  ctx.globalAlpha = fade * 0.68;
  ctx.strokeStyle = '#ffe18a';
  ctx.shadowColor = '#ffd151';
  ctx.shadowBlur = 7;
  ctx.lineWidth = Math.max(1.5, width * 0.68);
  ctx.beginPath();
  ctx.moveTo(particle.x1, particle.y1);
  ctx.lineTo(particle.x2, particle.y2);
  ctx.stroke();

  ctx.translate(particle.x2, particle.y2);
  ctx.rotate(particle.phase || 0);
  ctx.scale(1.35, 0.48);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, width * 2.7);
  glow.addColorStop(0, `rgba(255,239,171,${fade * 0.62})`);
  glow.addColorStop(0.28, `rgba(255,205,66,${fade * 0.34})`);
  glow.addColorStop(1, 'rgba(255,171,26,0)');
  ctx.fillStyle = glow;
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, width * 2.7, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawGoldSpark(ctx, particle, alpha, elapsed) {
  const twinkle = 0.64 + Math.sin(elapsed * 22 + particle.phase) * 0.36;
  const size = particle.radius * (0.78 + twinkle * 0.62);

  ctx.save();
  ctx.translate(particle.x, particle.y);
  ctx.rotate((particle.phase || 0) + elapsed * 0.9);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * (0.62 + twinkle * 0.38);
  ctx.strokeStyle = '#fff2b8';
  ctx.shadowColor = '#ffd447';
  ctx.shadowBlur = 9;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.8, size * 0.55);
  ctx.beginPath();
  ctx.moveTo(-size * 2.1, 0);
  ctx.lineTo(size * 2.1, 0);
  ctx.moveTo(0, -size * 2.1);
  ctx.lineTo(0, size * 2.1);
  ctx.stroke();

  ctx.rotate(Math.PI / 4);
  ctx.globalAlpha *= 0.62;
  ctx.lineWidth *= 0.72;
  ctx.beginPath();
  ctx.moveTo(-size * 1.35, 0);
  ctx.lineTo(size * 1.35, 0);
  ctx.moveTo(0, -size * 1.35);
  ctx.lineTo(0, size * 1.35);
  ctx.stroke();
  ctx.restore();
}
