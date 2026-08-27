import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { configVariable, defineConfig } from "hardhat/config";
import { fileURLToPath } from "node:url";

const solcPath = fileURLToPath(import.meta.resolve("solc/soljson.js"));

export default defineConfig({
  plugins: [
    hardhatEthers,
    hardhatKeystore,
    hardhatNetworkHelpers,
    hardhatNodeTestRunner,
    hardhatVerify
  ],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        path: solcPath,
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200
          },
          evmVersion: "london"
        }
      },
      production: {
        version: "0.8.28",
        path: solcPath,
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200
          },
          evmVersion: "london",
          metadata: {
            bytecodeHash: "ipfs"
          }
        }
      },
    }
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      hardfork: "london"
    },
    ronin: {
      type: "http",
      chainType: "l1",
      chainId: 2020,
      url: process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc",
      accounts: [configVariable("RONIN_DEPLOYER_PRIVATE_KEY")]
    },
    roninReadOnly: {
      type: "http",
      chainType: "l1",
      chainId: 2020,
      url: process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc",
      accounts: []
    },
    roninNftV2: {
      type: "http",
      chainType: "l1",
      chainId: 2020,
      url: process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc",
      accounts: [configVariable("NUGG_DEPLOYER_PRIVATE_KEY")]
    },
    saigon: {
      type: "http",
      chainType: "l1",
      chainId: 202601,
      url: process.env.SAIGON_RPC_URL || "https://saigon-testnet.roninchain.com/rpc",
      accounts: [configVariable("NUGG_DEPLOYER_PRIVATE_KEY")]
    },
    saigonReadOnly: {
      type: "http",
      chainType: "l1",
      chainId: 202601,
      url: process.env.SAIGON_RPC_URL || "https://saigon-testnet.roninchain.com/rpc",
      accounts: []
    }
  },
  verify: {
    sourcify: {
      enabled: true,
      apiUrl: "https://sourcify.dev/server"
    }
  }
});
