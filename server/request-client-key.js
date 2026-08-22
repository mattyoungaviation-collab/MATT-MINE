import { isIP } from 'node:net';

export function requestClientKey(request, options = {}) {
  const trustProxy = String(
    options.trustProxy ?? process.env.MATT_MINE_TRUST_PROXY ?? ''
  ).trim().toLowerCase();
  if (trustProxy === 'render') {
    const forwarded = firstForwardedAddress(request?.headers?.['x-forwarded-for']);
    const normalizedForwarded = normalizedIpAddress(forwarded);
    if (normalizedForwarded) return normalizedForwarded;
  }
  return normalizedIpAddress(request?.socket?.remoteAddress) || 'unknown';
}

function firstForwardedAddress(value) {
  const header = Array.isArray(value) ? value[0] : value;
  return String(header || '').split(',')[0].trim();
}

function normalizedIpAddress(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const ipv4 = candidate.slice('::ffff:'.length);
    return isIP(ipv4) === 4 ? ipv4 : '';
  }
  return isIP(candidate) ? candidate.toLowerCase() : '';
}
