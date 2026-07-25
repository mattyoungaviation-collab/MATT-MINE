import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPECTED_PROTOCOL,
  configHash,
  normalizeMainnetConfig
} from "../scripts/lib/mainnet-config.js";

function validConfig() {
  return {
    releaseId: "matt-mine-test",
    chainId: 2020,
    protocol: { ...EXPECTED_PROTOCOL },
    roles: {
      contractAdminMultisig: "0x0000000000000000000000000000000000000011",
      priceManager: "0x0000000000000000000000000000000000000012",
      configManager: "0x0000000000000000000000000000000000000013",
      pauser: "0x0000000000000000000000000000000000000014",
      rewardPublisher: "0x0000000000000000000000000000000000000015",
      treasuryManager: "0x0000000000000000000000000000000000000016"
    },
    treasuries: {
      operations: "0x0000000000000000000000000000000000000021",
      passRewards: "0x0000000000000000000000000000000000000022",
      growth: "0x0000000000000000000000000000000000000023",
      futureRewards: "0x0000000000000000000000000000000000000024",
      reserve: "0x0000000000000000000000000000000000000025"
    },
    pass: {
      initialPriceRonWei: "50",
      minimumPriceRonWei: "1",
      maximumPriceRonWei: "500"
    },
    paidRuns: {
      initialPriceRonWei: "10",
      minimumPriceRonWei: "5",
      maximumPriceRonWei: "20"
    }
  };
}

describe("Ronin Mainnet configuration guards", function () {
  it("normalizes the approved protocol addresses and produces a stable hash", function () {
    const first = normalizeMainnetConfig(validConfig());
    const reordered = {
      ...validConfig(),
      protocol: Object.fromEntries(
        Object.entries(validConfig().protocol).reverse()
      )
    };
    const second = normalizeMainnetConfig(reordered);
    assert.equal(configHash(first), configHash(second));
    assert.equal(first.protocol.mattToken, EXPECTED_PROTOCOL.mattToken);
  });

  it("rejects zero roles, wrong chain data, wrong protocol addresses, and bad price bounds", function () {
    const zeroRole = validConfig();
    zeroRole.roles.pauser = "0x0000000000000000000000000000000000000000";
    assert.throws(() => normalizeMainnetConfig(zeroRole), /has not been configured/);

    const wrongChain = validConfig();
    wrongChain.chainId = 202601;
    assert.throws(() => normalizeMainnetConfig(wrongChain), /chainId must be 2020/);

    const wrongToken = validConfig();
    wrongToken.protocol.mattToken =
      "0x0000000000000000000000000000000000000042";
    assert.throws(
      () => normalizeMainnetConfig(wrongToken),
      /does not match the approved Ronin address/
    );

    const badPrices = validConfig();
    badPrices.paidRuns.initialPriceRonWei = "21";
    assert.throws(
      () => normalizeMainnetConfig(badPrices),
      /prices are outside their configured bounds/
    );
  });

  it("rejects a single address controlling admin and routine roles", function () {
    const config = validConfig();
    config.roles.priceManager = config.roles.contractAdminMultisig;
    assert.throws(
      () => normalizeMainnetConfig(config),
      /must be separate from the contract admin multisig/
    );
  });
});
