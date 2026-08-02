import { EthereumProvider } from '@walletconnect/ethereum-provider';

export function createWalletConnectProvider(options) {
  return EthereumProvider.init(options);
}
