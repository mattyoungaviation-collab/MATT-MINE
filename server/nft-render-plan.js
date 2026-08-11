const UNDERLAY_ORDER = Object.freeze(['backpack']);
const OVERLAY_ORDER = Object.freeze(['helmet', 'weapon']);

/**
 * Resolves a compiled Miner NFT profile against the editable render manifest.
 * Armor replaces the base render; the remaining equipped NFTs stack above it.
 */
export function compileNftRenderPlan(profile, manifest, { publicOrigin = '' } = {}) {
  assertObject(profile, 'profile');
  assertObject(profile.render, 'profile.render');
  assertObject(manifest, 'manifest');
  assertObject(manifest.canvas, 'manifest.canvas');
  assertObject(manifest.baseEvolutions, 'manifest.baseEvolutions');
  assertObject(manifest.equipmentDefinitions, 'manifest.equipmentDefinitions');

  const baseEvolution = profile.render.baseEvolution;
  const evolution = manifest.baseEvolutions[baseEvolution];
  if (!evolution?.image) throw new Error(`unknown base evolution: ${baseEvolution}`);

  const equippedLayers = Array.isArray(profile.render.layers) ? profile.render.layers : [];
  const resolved = equippedLayers.map((layer) => resolveEquipmentLayer(layer, manifest));
  const armor = resolved.find(({ slot }) => slot === 'armor');
  if (armor && armor.definition.renderMode !== 'baseReplacement') {
    throw new Error(`armor definition ${armor.definitionId} must use baseReplacement rendering`);
  }

  const damaged = Boolean(profile.render.damagedArmorFlashRed && armor);
  const baseImage = armor
    ? damaged && armor.definition.damagedImage
      ? armor.definition.damagedImage
      : armor.definition.image
    : evolution.image;

  const underlays = resolveOrderedLayers(UNDERLAY_ORDER, resolved, manifest, publicOrigin);
  const backpackFront = resolveBackpackFront(resolved, manifest, publicOrigin);
  const starterWeapon = resolveStarterWeapon(resolved, manifest, publicOrigin);
  const overlays = [
    ...(backpackFront ? [backpackFront] : []),
    ...resolveOrderedLayers(OVERLAY_ORDER, resolved, manifest, publicOrigin),
    ...(starterWeapon ? [starterWeapon] : [])
  ];

  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    canvas: Object.freeze({
      width: positiveInteger(manifest.canvas.width, 'manifest.canvas.width'),
      height: positiveInteger(manifest.canvas.height, 'manifest.canvas.height')
    }),
    baseEvolution,
    underlays: Object.freeze(underlays.map(Object.freeze)),
    base: Object.freeze({
      source: armor ? 'equipped-armor' : 'level-evolution',
      definitionId: armor?.definitionId || 0,
      image: assetUrl(manifest, baseImage, publicOrigin)
    }),
    layers: Object.freeze(overlays.map(Object.freeze)),
    effect: damaged ? Object.freeze({
      type: 'faint-red-flash',
      ...normalizeDamageEffect(manifest.damagedArmorEffect)
    }) : null
  });
}

function resolveStarterWeapon(resolved, manifest, publicOrigin) {
  if (resolved.some(({ slot }) => slot === 'weapon')) return null;
  const starter = manifest.starterEquipment?.weapon;
  if (!starter?.image) return null;
  return {
    slot: 'weapon',
    tokenId: 0,
    definitionId: 0,
    rarity: 0,
    starter: true,
    image: assetUrl(manifest, starter.image, publicOrigin),
    transform: normalizeTransform(starter.transform)
  };
}

function resolveOrderedLayers(order, resolved, manifest, publicOrigin) {
  return order.flatMap((slot) => {
    const layer = resolved.find((candidate) => candidate.slot === slot);
    if (!layer) return [];
    if (!layer.definition.image) throw new Error(`${slot} definition ${layer.definitionId} has no image`);
    return [{
      slot,
      tokenId: layer.tokenId,
      definitionId: layer.definitionId,
      rarity: layer.rarity,
      image: assetUrl(manifest, layer.definition.image, publicOrigin),
      transform: normalizeTransform(layer.definition.transform)
    }];
  });
}

function resolveBackpackFront(resolved, manifest, publicOrigin) {
  const backpack = resolved.find(({ slot }) => slot === 'backpack');
  if (!backpack?.definition.frontImage) return null;
  return {
    slot: 'backpack-front',
    tokenId: backpack.tokenId,
    definitionId: backpack.definitionId,
    rarity: backpack.rarity,
    image: assetUrl(manifest, backpack.definition.frontImage, publicOrigin),
    transform: normalizeTransform(backpack.definition.frontTransform)
  };
}

function resolveEquipmentLayer(layer, manifest) {
  assertObject(layer, 'render layer');
  const definitionId = positiveInteger(layer.definitionId, 'render layer definitionId');
  const definition = manifest.equipmentDefinitions[String(definitionId)];
  if (!definition) throw new Error(`unknown equipment definition: ${definitionId}`);
  if (definition.slot !== layer.slot) throw new Error(`definition ${definitionId} is not a ${layer.slot}`);
  return {
    slot: layer.slot,
    tokenId: positiveInteger(layer.tokenId, `${layer.slot} tokenId`),
    definitionId,
    rarity: nonNegativeInteger(layer.rarity, `${layer.slot} rarity`),
    definition
  };
}

function assetUrl(manifest, relativePath, publicOrigin) {
  const cleanPath = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!cleanPath || cleanPath.split('/').includes('..')) throw new Error(`unsafe NFT asset path: ${relativePath}`);
  const base = `/${String(manifest.publicBaseUrl || '/assets/nft').replace(/^\/+|\/+$/g, '')}`;
  const origin = String(publicOrigin || '').replace(/\/+$/, '');
  return `${origin}${base}/${cleanPath}`;
}

function normalizeTransform(value = {}) {
  const transform = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const x = finiteNumber(transform.x ?? 0, 'transform.x');
  const y = finiteNumber(transform.y ?? 0, 'transform.y');
  const scale = finiteNumber(transform.scale ?? 1, 'transform.scale');
  if (scale <= 0) throw new Error('transform.scale must be greater than zero');
  return Object.freeze({ x, y, scale });
}

function normalizeDamageEffect(value = {}) {
  assertObject(value, 'manifest.damagedArmorEffect');
  const maximumOpacity = finiteNumber(value.maximumOpacity, 'damagedArmorEffect.maximumOpacity');
  if (maximumOpacity < 0 || maximumOpacity > 1) throw new Error('damaged armor opacity must be between zero and one');
  return {
    tint: String(value.tint || '#ff3b30'),
    maximumOpacity,
    flashPeriodMilliseconds: positiveInteger(
      value.flashPeriodMilliseconds,
      'damagedArmorEffect.flashPeriodMilliseconds'
    )
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a safe non-negative integer`);
  return number;
}

function positiveInteger(value, label) {
  const number = nonNegativeInteger(value, label);
  if (number === 0) throw new Error(`${label} must be greater than zero`);
  return number;
}
