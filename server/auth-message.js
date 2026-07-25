import { ApiError } from './errors.js';

export function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    return url.origin;
  } catch {
    throw new ApiError(400, 'invalid_origin', 'A valid HTTP or HTTPS origin is required.');
  }
}

export function buildSignInMessage({
  origin,
  address,
  chainId,
  nonce,
  issuedAt,
  expirationTime
}) {
  const normalizedOrigin = normalizeOrigin(origin);
  const domain = new URL(normalizedOrigin).host;
  return `${domain} wants you to sign in with your Ronin account:
${address}

Sign in to MATT Mine. This request does not initiate a transaction or spend RON or MATT.

URI: ${normalizedOrigin}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;
}
