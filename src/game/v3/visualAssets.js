const VISUAL_ASSET_PATHS = Object.freeze({
  floor: '/assets/game/mine-floor-cinematic.webp',
  guardian: '/assets/game/guardian-cinematic.webp',
  guardianAnimated: '/assets/game/guardian-animated-spritesheet.webp',
  mattDyno: '/assets/game/matt-dyno-spritesheet.png',
  mattDynoBlaster: '/assets/game/matt-dyno-blaster-spritesheet.png',
  mattDynoDynamite: '/assets/game/matt-dyno-dynamite-spritesheet.png',
  mattDynoPickaxeVertical: '/assets/game/matt-dyno-pickaxe-vertical-spritesheet.png',
  mattDynoBlasterVertical: '/assets/game/matt-dyno-blaster-vertical-spritesheet.png',
  mattDynoDynamiteVertical: '/assets/game/matt-dyno-dynamite-vertical-spritesheet.png',
  ronkeCharacter: '/assets/game/ronke-character-spritesheet.webp',
  axieCharacter: '/assets/game/axie-character-spritesheet.webp',
  orcCharacter: '/assets/game/orc-character-spritesheet.webp'
});

export function loadVisualAssets(ImageConstructor = globalThis.Image) {
  if (typeof ImageConstructor !== 'function') return {};
  return Object.fromEntries(
    Object.entries(VISUAL_ASSET_PATHS).map(([key, source]) => {
      const image = new ImageConstructor();
      image.decoding = 'async';
      image.src = source;
      return [key, image];
    })
  );
}

export function imageIsReady(image) {
  return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
}
