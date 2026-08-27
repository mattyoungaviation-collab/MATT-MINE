import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { AbiCoder, id, keccak256 } from "ethers";
import {
  ENDLESS_MAINNET_ROOT,
  normalizeEndlessMainnetConfig
} from "../scripts/lib/nft-v2-endless-mainnet.js";

const examplePath = resolve("config", "ronin-nft-v2-endless.example.json");
const preflightPath = resolve("scripts", "check-nft-v2-endless-deployer.js");
const verifierPath = resolve("scripts", "verify-nft-v2-endless-mainnet.js");
const packagePath = resolve("package.json");
const example = () => JSON.parse(readFileSync(examplePath, "utf8"));

describe("NFT V2 Endless deployment configuration", () => {
  it("turns the adjustable conservative preset into one exact immutable version route", () => {
    const config = normalizeEndlessMainnetConfig(example(), examplePath);
    const version = config.versions["endless-conservative-v1"];
    assert.equal(config.roles.rootAdmin, ENDLESS_MAINNET_ROOT);
    assert.equal(version.input.generatorHash, id("endless-map-v1"));
    assert.equal(version.input.conversionRate, 2_500_000_000_000_000n);
    assert.equal(version.input.maximumPayout, 10n * 10n ** 18n);
    assert.equal(version.input.maximumDailyPayout, 500n * 10n ** 18n);
    assert.equal(version.input.maximumPhases, 1_000_000);
    assert.equal(version.input.phaseXp, 10);
    const independentlyEncoded = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint128", "uint128", "uint128", "uint32", "uint32", "uint32", "uint32", "uint32", "uint32", "uint32", "bool"],
      [
        version.input.generatorHash,
        version.input.configHash,
        version.input.conversionRate,
        version.input.maximumPayout,
        version.input.maximumDailyPayout,
        version.input.mineableCrystalUnits,
        version.input.maximumPhases,
        version.input.phaseXp,
        version.input.maximumRunXp,
        version.input.maximumWalletXpPerDay,
        version.input.maximumMinerXpPerDay,
        version.input.checkpointTimeout,
        version.input.failedRunsRetainXp
      ]
    ));
    assert.equal(version.versionId, independentlyEncoded);
  });

  it("rejects unsafe role overlap and out-of-range adjustable economy values", () => {
    const sharedRole = example();
    sharedRole.roles.rewardSigner = sharedRole.roles.gameOperator;
    assert.throws(() => normalizeEndlessMainnetConfig(sharedRole, examplePath), /separate wallets/i);
    const zeroXp = example();
    zeroXp.versions["endless-conservative-v1"].phaseXp = 0;
    assert.throws(() => normalizeEndlessMainnetConfig(zeroXp, examplePath), /phase XP.*range/i);
    const badDaily = example();
    badDaily.versions["endless-conservative-v1"].maximumDailyPayoutWei = "1";
    assert.throws(() => normalizeEndlessMainnetConfig(badDaily, examplePath), /daily payout cannot be lower/i);
  });

  it("uses the supported Hardhat 3 runtime surfaces in the read-only preflight", () => {
    const source = readFileSync(preflightPath, "utf8");
    assert.match(source, /import \{ getAddress, getCreateAddress, parseEther \} from "ethers"/);
    assert.match(source, /import hre, \{ network \} from "hardhat"/);
    assert.match(source, /hre\.artifacts\.readArtifact\("MattV2EndlessSettlement"\)/);
    assert.doesNotMatch(source, /ethers\.artifacts/);
  });

  it("provides a repeatable read-only Sourcify verifier without changing activation state", () => {
    const source = readFileSync(verifierPath, "utf8");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    assert.match(packageJson.scripts["verify-nft-v2-endless:ronin"], /verify-nft-v2-endless-mainnet\.js/);
    assert.match(source, /provider: "sourcify"/);
    assert.match(source, /creationTxHash: record\.transactionHash/);
    assert.match(source, /record\.sourcifyVerifiedAt/);
    assert.doesNotMatch(source, /manifest\.status\s*=/);
    assert.doesNotMatch(source, /writeContract|\.unpause\(/);
  });
});
