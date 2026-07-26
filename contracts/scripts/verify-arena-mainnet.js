import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import {
  ARENA_DEPLOYMENT_PATH,
  RONIN_CHAIN_ID,
  assertArenaManifest,
  loadArenaDeploymentManifest,
  loadArenaMainnetConfig,
  validateArenaOnchainConfig,
  verifyArenaDeploymentState,
  writeArenaDeploymentManifest
} from "./lib/arena-mainnet.js";

const SOURCIFY_API = "https://sourcify.dev/server";

async function lookupSourcify(address) {
  const response = await fetch(
    `${SOURCIFY_API}/v2/contract/${RONIN_CHAIN_ID}/${address}`
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Sourcify lookup failed with HTTP ${response.status}: ${await response.text()}`
    );
  }
  const result = await response.json();
  if (
    result === null
    || typeof result !== "object"
    || !("match" in result)
  ) {
    throw new Error(
      `Sourcify returned an unexpected response: ${JSON.stringify(result)}`
    );
  }
  return result;
}

function requireExactMatch(result, address) {
  if (
    result?.match !== "exact_match"
    || result.creationMatch !== "exact_match"
    || result.runtimeMatch !== "exact_match"
  ) {
    throw new Error(
      `Sourcify verification for ${address} is not exact: overall=${result?.match ?? "none"}, creation=${result?.creationMatch ?? "none"}, runtime=${result?.runtimeMatch ?? "none"}.`
    );
  }
}

const { ethers } = await network.create();
const connectedNetwork = await ethers.provider.getNetwork();
if (connectedNetwork.chainId !== RONIN_CHAIN_ID) {
  throw new Error(
    `Verification must use Ronin Mainnet ${RONIN_CHAIN_ID}.`
  );
}

const config = loadArenaMainnetConfig();
const manifest = loadArenaDeploymentManifest();
assertArenaManifest(manifest, config);
if (!["deployed_unverified", "verified_exact"].includes(manifest.status)) {
  throw new Error(
    `Arena deployment manifest has incomplete status ${manifest.status}.`
  );
}

await validateArenaOnchainConfig(ethers, config);
const checked = await verifyArenaDeploymentState(ethers, config, manifest, {
  requireEmptyBalances: true
});
const record = manifest.contracts.MattMineDailyArena;
let match = await lookupSourcify(checked.address);

if (match === null) {
  console.log(
    `MattMineDailyArena: submitting ${checked.address} to Sourcify...`
  );
  await verifyContract(
    {
      address: checked.address,
      constructorArgs: record.constructorArgs,
      creationTxHash: record.transactionHash,
      provider: "sourcify"
    },
    hre
  );
  match = await lookupSourcify(checked.address);
} else {
  console.log("MattMineDailyArena: Sourcify already has a match record.");
}

requireExactMatch(match, checked.address);
record.sourcify = {
  match: match.match,
  creationMatch: match.creationMatch,
  runtimeMatch: match.runtimeMatch,
  verifiedAt: match.verifiedAt ?? new Date().toISOString()
};
manifest.status = "verified_exact";
manifest.verifiedAt = new Date().toISOString();
manifest.updatedAt = manifest.verifiedAt;
writeArenaDeploymentManifest(manifest);

console.log("MattMineDailyArena has an exact creation and runtime match.");
console.log(
  `Sourcify: https://repo.sourcify.dev/contracts/full_match/${RONIN_CHAIN_ID}/${checked.address}/`
);
console.log(`Deployment record: ${ARENA_DEPLOYMENT_PATH}`);
console.log("No onchain transaction was broadcast.");
