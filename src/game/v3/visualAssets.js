const VISUAL_ASSET_PATHS = Object.freeze({
  floor: '/assets/game/mine-floor-cinematic.webp',
  guardian: '/assets/game/guardian-cinematic.webp'
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
