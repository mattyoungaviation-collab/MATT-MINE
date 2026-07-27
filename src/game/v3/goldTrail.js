import { stateMethods } from './state.js';

const GOLD_TRAIL_INTERVAL = 0.028;
const GOLD_TRAIL_GROUND_OFFSET_Y = 22;
const GOLD_TRAIL_BEHIND_DISTANCE = 17;
const GOLD_TRAIL_MAX_SEGMENT = 58;

export const goldTrailMethods = {
  updatePlayerMovement(dt) {
    const equipped = this.cosmetics?.trail === 'gold_trail';
    const cosmetics = this.cosmetics;
    const startX = this.player.x;
    const startY = this.player.y;

    // The original trail implementation lives inside the movement method and
    // emits a round particle with upward velocity. Hide only that cosmetic
    // while preserving the complete movement and dash implementation.
    if (equipped) this.cosmetics = { ...cosmetics, trail: '' };
    try {
      stateMethods.updatePlayerMovement.call(this, dt);
    } finally {
      if (equipped) this.cosmetics = cosmetics;
    }

    if (!equipped) {
      resetGoldTrail(this.player);
      return;
    }

    this.player.goldTrailTimer = Math.max(0, Number(this.player.goldTrailTimer || 0) - dt);

    // Dash already owns a bright cyan effect. Reset the gold anchor so the
    // next normal step cannot draw a long segment across the dash distance.
    if (this.player.dashTimer > 0) {
      resetGoldTrailAnchor(this.player);
      return;
    }

    const movedX = this.player.x - startX;
    const movedY = this.player.y - startY;
    const movedDistance = Math.hypot(movedX, movedY);
    if (movedDistance < 0.12) {
      resetGoldTrailAnchor(this.player);
      return;
    }

    const directionX = movedX / movedDistance;
    const directionY = movedY / movedDistance;
    const step = Math.max(0, Math.floor(Number(this.player.goldTrailStep) || 0));
    const lateralNoise = (trailNoise(step, 1) - 0.5) * 4.5;
    const perpendicularX = -directionY;
    const perpendicularY = directionX;
    const groundX = this.player.x - directionX * GOLD_TRAIL_BEHIND_DISTANCE + perpendicularX * lateralNoise;
    const groundY = this.player.y + GOLD_TRAIL_GROUND_OFFSET_Y - directionY * GOLD_TRAIL_BEHIND_DISTANCE + perpendicularY * lateralNoise;

    if (this.player.goldTrailTimer > 0) return;
    this.player.goldTrailTimer = GOLD_TRAIL_INTERVAL;
    this.player.goldTrailStep = step + 1;

    const previousX = Number(this.player.goldTrailX);
    const previousY = Number(this.player.goldTrailY);
    const hasPrevious = Number.isFinite(previousX) && Number.isFinite(previousY) &&
      Math.hypot(groundX - previousX, groundY - previousY) <= GOLD_TRAIL_MAX_SEGMENT;
    const segmentStartX = hasPrevious ? previousX : groundX - directionX * 7;
    const segmentStartY = hasPrevious ? previousY : groundY - directionY * 7;

    this.particles.push({
      kind: 'gold_trail_glow',
      layer: 'ground',
      x: groundX,
      y: groundY,
      x1: segmentStartX,
      y1: segmentStartY,
      x2: groundX,
      y2: groundY,
      vx: 0,
      vy: 0,
      radius: 5.5 + trailNoise(step, 2) * 2.25,
      phase: trailNoise(step, 3) * Math.PI * 2,
      life: 0.48,
      maxLife: 0.48
    });

    const sparkleCount = step % 3 === 0 ? 2 : 1;
    for (let index = 0; index < sparkleCount; index += 1) {
      const sparkleNoise = trailNoise(step, 10 + index);
      const along = (sparkleNoise - 0.5) * 9;
      const side = (trailNoise(step, 20 + index) - 0.5) * 7;
      this.particles.push({
        kind: 'gold_trail_spark',
        layer: 'ground',
        x: groundX + directionX * along + perpendicularX * side,
        y: groundY + directionY * along + perpendicularY * side,
        vx: 0,
        vy: 0,
        radius: 1.15 + trailNoise(step, 30 + index) * 1.15,
        phase: trailNoise(step, 40 + index) * Math.PI * 2,
        life: 0.32 + trailNoise(step, 50 + index) * 0.14,
        maxLife: 0.46
      });
    }

    this.player.goldTrailX = groundX;
    this.player.goldTrailY = groundY;
  }
};

function resetGoldTrail(player) {
  player.goldTrailTimer = 0;
  resetGoldTrailAnchor(player);
}

function resetGoldTrailAnchor(player) {
  player.goldTrailX = Number.NaN;
  player.goldTrailY = Number.NaN;
}

function trailNoise(step, salt) {
  const value = Math.sin((step + 1) * 12.9898 + salt * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}
