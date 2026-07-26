import { ApiError, assertApi } from './errors.js';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 16;
export const AVATAR_MAX_BYTES = 48 * 1024;

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const RESERVED_NAMES = new Set([
  'admin',
  'administrator',
  'matt',
  'mattmine',
  'moderator',
  'official',
  'owner',
  'staff',
  'support',
  'treasury'
]);

export function validateUsername(input) {
  assertApi(typeof input === 'string', 400, 'username_required', 'Choose a miner name.');
  const name = input.normalize('NFKC').trim();
  assertApi(
    name.length >= USERNAME_MIN_LENGTH && name.length <= USERNAME_MAX_LENGTH,
    400,
    'username_length',
    `Miner names must be ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters.`
  );
  assertApi(
    USERNAME_PATTERN.test(name),
    400,
    'username_characters',
    'Miner names may contain only letters, numbers, and underscores.'
  );
  const key = name.toLowerCase();
  assertApi(!RESERVED_NAMES.has(key), 409, 'username_reserved', 'That miner name is reserved.');
  return { name, key };
}

export function validateAvatarDataUrl(input, { optional = false } = {}) {
  if ((input === '' || input === null || input === undefined) && optional) return '';
  assertApi(typeof input === 'string', 400, 'avatar_required', 'Choose a profile picture.');
  const match = input.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  assertApi(match, 400, 'avatar_format', 'Profile pictures must be PNG, JPEG, or WebP images.');

  let bytes;
  try {
    bytes = Buffer.from(match[2], 'base64');
  } catch {
    throw new ApiError(400, 'avatar_encoding', 'The profile picture is not valid base64 image data.');
  }
  assertApi(bytes.length > 0 && bytes.length <= AVATAR_MAX_BYTES, 413, 'avatar_too_large', 'The resized profile picture must be 48 KB or smaller.');
  assertApi(matchesImageSignature(match[1], bytes), 400, 'avatar_signature', 'The uploaded file does not match its image type.');
  return `data:image/${match[1]};base64,${bytes.toString('base64')}`;
}

export function normalizeIdentity(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalizedName = storedUsername(source.name);
  const nameKey = normalizedName ? normalizedName.toLowerCase() : '';
  return {
    name: normalizedName,
    nameKey,
    avatarDataUrl: storedAvatar(source.avatarDataUrl),
    createdAt: safeTimestamp(source.createdAt),
    avatarUpdatedAt: safeTimestamp(source.avatarUpdatedAt)
  };
}

function storedUsername(value) {
  if (typeof value !== 'string') return '';
  const name = value.normalize('NFKC').trim();
  return name.length >= USERNAME_MIN_LENGTH &&
    name.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(name)
    ? name
    : '';
}

function storedAvatar(value) {
  try {
    return validateAvatarDataUrl(value, { optional: true });
  } catch {
    return '';
  }
}

function matchesImageSignature(type, bytes) {
  if (type === 'png') {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes.subarray(1, 4).toString('ascii') === 'PNG';
  }
  if (type === 'jpeg') {
    return bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
  }
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
