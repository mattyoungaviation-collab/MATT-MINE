import {
  COMPETITION_DEPTH_COUNT,
  COMPETITION_SLOTS,
  normalizeCompetitionDraft,
  validateCompetitionDraft
} from './competitionStudio.js';

export const COMPETITION_MAP_FILE_FORMAT = 'matt-mine-competition-map';
export const COMPETITION_MAP_FILE_VERSION = 1;
export const COMPETITION_MAP_FILE_MAX_BYTES = 5 * 1024 * 1024;

export function createCompetitionMapFile(draft, slotId, now = Date.now()) {
  const normalized = normalizeCompetitionDraft(draft, slotId);
  const validation = validateCompetitionDraft(normalized);
  return {
    format: COMPETITION_MAP_FILE_FORMAT,
    version: COMPETITION_MAP_FILE_VERSION,
    mineType: normalized.slotId,
    name: normalized.name,
    exportedAt: new Date(now).toISOString(),
    summary: {
      depths: normalized.depths.length,
      rooms: validation.counts.rooms,
      objects: validation.counts.objects,
      enemies: validation.counts.enemies,
      valid: validation.valid
    },
    draft: normalized
  };
}

export function parseCompetitionMapFile(text, expectedSlotId = '') {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('The selected map file is empty.');
  if (new TextEncoder().encode(text).byteLength > COMPETITION_MAP_FILE_MAX_BYTES) {
    throw new TypeError('The selected map file is larger than 5 MB.');
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError('The selected file is not valid JSON.');
  }
  if (!isRecord(value) || value.format !== COMPETITION_MAP_FILE_FORMAT) {
    throw new TypeError('This is not a MATT Mine Competition Studio map file.');
  }
  if (value.version !== COMPETITION_MAP_FILE_VERSION) {
    throw new TypeError(`Map file version ${String(value.version || 'unknown')} is not supported.`);
  }

  const mineType = String(value.mineType || value.draft?.slotId || '');
  const slot = COMPETITION_SLOTS.find((entry) => entry.id === mineType && !entry.comingSoon);
  if (!slot) throw new TypeError('The map file does not identify a playable mine type.');
  if (expectedSlotId && mineType !== expectedSlotId) {
    const expected = COMPETITION_SLOTS.find((entry) => entry.id === expectedSlotId)?.name || expectedSlotId;
    throw new TypeError(`This file is for ${slot.name}. Switch from ${expected} to ${slot.name} before importing it.`);
  }
  assertCompleteDraft(value.draft);

  const draft = normalizeCompetitionDraft(value.draft, mineType);
  return {
    file: {
      format: value.format,
      version: value.version,
      mineType,
      name: String(value.name || draft.name).slice(0, 48),
      exportedAt: String(value.exportedAt || '')
    },
    draft,
    validation: validateCompetitionDraft(draft)
  };
}

export function competitionMapFileName(mapFile) {
  const mineType = slug(mapFile?.mineType || mapFile?.draft?.slotId || 'mine');
  const name = slug(mapFile?.name || mapFile?.draft?.name || 'saved-map');
  const exported = Date.parse(mapFile?.exportedAt);
  const date = Number.isFinite(exported)
    ? new Date(exported).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    : 'saved';
  return `matt-mine-${mineType}-${name}-${date}.mattmine.json`;
}

function assertCompleteDraft(draft) {
  if (!isRecord(draft) || !Array.isArray(draft.depths) || draft.depths.length !== COMPETITION_DEPTH_COUNT) {
    throw new TypeError(`A Competition Studio file must contain exactly ${COMPETITION_DEPTH_COUNT} depth maps.`);
  }
  for (let index = 0; index < COMPETITION_DEPTH_COUNT; index += 1) {
    const map = draft.depths[index]?.map;
    if (!isRecord(map) || !Array.isArray(map.rooms) || !Array.isArray(map.corridors) || !Array.isArray(map.objects)) {
      throw new TypeError(`Depth ${index + 1} is missing its rooms, corridors, or objects.`);
    }
  }
}

function slug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'map';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
