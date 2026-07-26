import { drawEnemyBody } from './renderEnemyBody.js';

export const renderEnemyMethods = {
  drawEnemies(ctx) {
    for (const enemy of this.enemies) {
      if (!this.inView(enemy, 80)) continue;
      ctx.save();
      ctx.translate(enemy.x, enemy.y);
      drawEnemyBody(ctx, enemy, this.visualAssets);
      ctx.restore();
      if (!enemy.hidden) this.drawHealthBar(ctx, enemy, enemy.hp / enemy.maxHp, enemy.radius * 2.2, enemy.isBoss ? 9 : 5);
    }
  }
};
