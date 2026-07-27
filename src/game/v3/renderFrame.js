import { randomRange } from '../utils.js';

export const renderFrameMethods = {
  render() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    ctx.save();
    const activeShake = this.state === 'playing' && this.screenShakeEnabled
      ? this.camera.shake
      : 0;
    const shakeX = activeShake ? randomRange(-activeShake, activeShake) : 0;
    const shakeY = activeShake ? randomRange(-activeShake, activeShake) : 0;
    ctx.translate(-this.camera.x + shakeX, -this.camera.y + shakeY);
    this.drawWorld(ctx);
    if (this.run && this.player) {
      this.drawPortal(ctx);
      this.drawOres(ctx);
      this.drawPickups(ctx);
      this.drawGroundTrails(ctx);
      this.drawProjectiles(ctx);
      this.drawEnemies(ctx);
      this.drawPlayer(ctx);
      this.drawDrones(ctx);
      this.drawParticles(ctx);
      this.drawTracers(ctx);
      this.drawFloaters(ctx);
      this.drawLighting(ctx);
    }
    ctx.restore();
  }
};
