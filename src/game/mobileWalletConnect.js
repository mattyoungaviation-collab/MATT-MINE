const RONIN_WALLET_DEEP_LINK = 'roninwallet://';
const WALLETCONNECT_DEEP_LINK_CHOICE = 'WALLETCONNECT_DEEPLINK_CHOICE';

export function needsMobileWalletConnectHandoff(windowObject = globalThis.window) {
  const navigatorObject = windowObject?.navigator;
  const userAgent = String(navigatorObject?.userAgent || '');
  const mobileUserAgent = /Android|iPhone|iPad|iPod/i.test(userAgent);
  const touchIpad = /Macintosh/i.test(userAgent) && Number(navigatorObject?.maxTouchPoints || 0) > 1;
  return mobileUserAgent || touchIpad;
}

export function roninWalletPairingUrl(pairingUri) {
  const uri = String(pairingUri || '').trim();
  if (!/^wc:[^\s]+$/i.test(uri)) throw new Error('WalletConnect did not provide a valid pairing link.');
  return `${RONIN_WALLET_DEEP_LINK}wc?uri=${encodeURIComponent(uri)}`;
}

export function rememberRoninWalletChoice(windowObject = globalThis.window) {
  try {
    windowObject?.localStorage?.setItem(WALLETCONNECT_DEEP_LINK_CHOICE, JSON.stringify({
      href: RONIN_WALLET_DEEP_LINK,
      name: 'Ronin Wallet'
    }));
  } catch {
    // The pairing link still works when Safari blocks optional local storage.
  }
}
