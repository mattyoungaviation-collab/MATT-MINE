const RONIN_MAINNET_CHAIN_ID = 2020;
const WALLETCONNECT_BUNDLE_URL = new URL(
  '../../generated/walletconnect/walletconnect.js',
  import.meta.url
).href;

const walletConnectStates = new WeakMap();

export async function resolveRoninProvider(options = {}) {
  const windowObject = options.windowObject || globalThis.window;
  const injected = windowObject?.ronin?.provider;
  if (options.forceWalletConnect !== true && injected?.request) {
    return { provider: injected, kind: 'injected' };
  }

  const config = options.config || await fetchRuntimeConfig(windowObject);
  const projectId = String(config?.walletConnect?.projectId || '').trim();
  if (!config?.walletConnect?.enabled || !projectId) {
    throw new Error(
      'WalletConnect is not configured yet. Open MATT Mine in the Ronin Wallet browser or try again shortly.'
    );
  }

  const provider = await walletConnectProvider({
    windowObject,
    projectId,
    createProvider: options.createWalletConnectProvider
  });
  if (!provider?.request) {
    throw new Error('WalletConnect did not provide a compatible Ronin wallet connection.');
  }

  if (options.connect !== false && !provider.session) {
    try {
      await provider.connect();
    } catch (error) {
      throw new Error(walletConnectionError(error));
    }
  }
  return { provider, kind: 'walletconnect' };
}

async function walletConnectProvider({ windowObject, projectId, createProvider }) {
  const cached = walletConnectStates.get(windowObject);
  if (cached?.projectId === projectId) return cached.promise;

  const promise = Promise.resolve()
    .then(async () => {
      const factory = createProvider || await loadWalletConnectFactory();
      return factory({
        projectId,
        chains: [RONIN_MAINNET_CHAIN_ID],
        showQrModal: true,
        metadata: walletConnectMetadata(windowObject),
        qrModalOptions: {
          themeMode: 'dark',
          enableMobileFullScreen: true
        }
      });
    })
    .catch((error) => {
      walletConnectStates.delete(windowObject);
      throw new Error(walletInitializationError(error));
    });
  walletConnectStates.set(windowObject, { projectId, promise });
  return promise;
}

async function loadWalletConnectFactory() {
  const module = await import(WALLETCONNECT_BUNDLE_URL);
  if (typeof module.createWalletConnectProvider !== 'function') {
    throw new Error('The WalletConnect client bundle is invalid.');
  }
  return module.createWalletConnectProvider;
}

async function fetchRuntimeConfig(windowObject) {
  const fetchFunction = windowObject?.fetch?.bind(windowObject) || globalThis.fetch?.bind(globalThis);
  if (!fetchFunction) throw new Error('This browser cannot load the WalletConnect configuration.');
  const response = await fetchFunction('/api/config', { headers: { accept: 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message || 'MATT Mine could not load its wallet configuration.');
  }
  return payload.config;
}

function walletConnectMetadata(windowObject) {
  const origin = String(windowObject?.location?.origin || '').replace(/\/$/, '');
  return {
    name: 'MATT Mine',
    description: 'Connect Ronin Wallet to play MATT Mine on Ronin Mainnet.',
    url: origin || 'https://matt-mine.onrender.com',
    icons: [`${origin || 'https://matt-mine.onrender.com'}/assets/favicon.svg`]
  };
}

function walletInitializationError(error) {
  const message = cleanErrorMessage(error);
  if (/failed to fetch dynamically imported module|walletconnect client bundle|404/i.test(message)) {
    return 'WalletConnect is temporarily unavailable. Refresh MATT Mine and try again.';
  }
  return message
    ? `WalletConnect could not start: ${message}`
    : 'WalletConnect could not start. Refresh MATT Mine and try again.';
}

function walletConnectionError(error) {
  const message = cleanErrorMessage(error);
  if (Number(error?.code) === 4001 || /cancel|reject|reset|closed/i.test(message)) {
    return 'The WalletConnect request was canceled.';
  }
  return message
    ? `WalletConnect could not connect to Ronin Wallet: ${message}`
    : 'WalletConnect could not connect to Ronin Wallet.';
}

function cleanErrorMessage(error) {
  return String(error?.shortMessage || error?.message || '')
    .replace(/^Error:\s*/i, '')
    .trim()
    .slice(0, 240);
}

export function resetWalletConnectProviderForTesting(windowObject) {
  if (windowObject) walletConnectStates.delete(windowObject);
}
