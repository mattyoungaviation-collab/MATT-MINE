import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_CONTEXT_DEPLOYMENT_GAS_CEILING,
  buildNftV2DeploymentPlan,
  requiresPriorNftV2Deployments
} from "../scripts/lib/nft-v2-deployment-plan.js";

const ROOT = getAddress("0xF79913cB83Cc9CABD95D0ba9250103fbb939f984");

describe("NFT V2 deterministic mainnet deployment plan", () => {
  it("locks all fourteen create addresses, nonces, proxies, and cross-contract constructor references", async () => {
    const { ethers } = await network.create();
    const config = {
      roles: {
        rootAdmin: ROOT, treasury: ROOT, emergencyPauser: ROOT,
        gameOperator: ROOT, rewardSigner: ROOT, keeper: ROOT
      },
      metadata: {
        minerBaseUri: "https://example.com/miners/", minerContractUri: "https://example.com/miners.json",
        equipmentBaseUri: "https://example.com/equipment/", equipmentContractUri: "https://example.com/equipment.json"
      },
      protocol: {
        mattToken: "0x1111111111111111111111111111111111111111",
        crystalToken: "0x2222222222222222222222222222222222222222",
        vrfCoordinator: "0x3333333333333333333333333333333333333333",
        vrfSubscriptionId: 1n,
        vrfKeyHash: `0x${"44".repeat(32)}`
      },
      economy: { repairPriceMattWei: 1n },
      vrf: { requestConfirmations: 3, coordinatorCallbackGasLimit: 1_400_000, consumerCallbackGasLimit: 1_000_000 }
    };
    const plan = await buildNftV2DeploymentPlan(ethers, config, ROOT, 42);
    assert.equal(plan.steps.length, 14);
    assert.equal(plan.endingNonce, 56);
    assert.deepEqual(plan.steps.map(({ nonce }) => nonce), Array.from({ length: 14 }, (_, index) => index + 42));
    assert.equal(new Set(plan.steps.map(({ address }) => address)).size, 14);
    assert.deepEqual(plan.steps.map(({ label }) => label), [
      "UpgradeTimelock", "Miner", "Equipment", "ChestRandomness", "PassiveRandomness", "Loadout",
      "CrystalBankImplementation", "CrystalBankProxy", "PassiveRewardsImplementation", "PassiveRewardsProxy",
      "GameSettlementImplementation", "GameSettlementProxy", "ChestImplementation", "ChestProxy"
    ]);
    assert.equal(plan.steps.find(({ label }) => label === "Loadout").args[1], plan.planned.Miner);
    assert.equal(plan.steps.find(({ label }) => label === "CrystalBankProxy").args[0], plan.planned.CrystalBankImplementation);
    assert.equal(plan.steps.find(({ label }) => label === "PassiveRewardsProxy").args[0], plan.planned.PassiveRewardsImplementation);
    assert.equal(plan.steps.find(({ label }) => label === "GameSettlementProxy").args[0], plan.planned.GameSettlementImplementation);
    assert.equal(plan.steps.find(({ label }) => label === "ChestProxy").args[0], plan.planned.ChestImplementation);
  });

  it("uses a conservative read-only gas ceiling after constructors begin validating prior CREATEs", () => {
    const independent = ["UpgradeTimelock", "Miner", "Equipment", "ChestRandomness", "PassiveRandomness"];
    const dependent = ["Loadout", "CrystalBankImplementation", "CrystalBankProxy", "PassiveRewardsImplementation", "PassiveRewardsProxy", "GameSettlementImplementation", "GameSettlementProxy", "ChestImplementation", "ChestProxy"];
    assert.equal(NFT_V2_CONTEXT_DEPLOYMENT_GAS_CEILING, 8_000_000n);
    assert.ok(independent.every((label) => !requiresPriorNftV2Deployments(label)));
    assert.ok(dependent.every((label) => requiresPriorNftV2Deployments(label)));
  });
});
