const PUBLIC_RONIN_RPC_URL = 'https://api.roninchain.com/rpc';

export function nftRpcUrlFromEnvironment(environment = process.env) {
  const explicit = String(environment.MATT_MINE_NFT_RPC_URL || '').trim();
  if (explicit) return httpsUrl(explicit);
  const shared = String(environment.RONIN_RPC_URLS || environment.RONIN_RPC_URL || '')
    .split(',')
    .map((value) => value.trim())
    .find(Boolean);
  return shared ? httpsUrl(shared) : PUBLIC_RONIN_RPC_URL;
}

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('NFT RPC URL must use HTTPS.');
  return url.href;
}
