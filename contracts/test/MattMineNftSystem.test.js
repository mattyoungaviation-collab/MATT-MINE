import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const role = (name) => ethers.id(name);
const MINTER_ROLE = role("MINTER_ROLE");
const PROGRESSION_ROLE = role("PROGRESSION_ROLE");
const METADATA_ROLE = role("METADATA_ROLE");
const LOADOUT_ROLE = role("LOADOUT_ROLE");
const STATE_ROLE = role("STATE_ROLE");
const BURNER_ROLE = role("BURNER_ROLE");
const GAME_ROLE = role("GAME_ROLE");

async function expectCustomError(promise, contract, errorName) {
  try {
    await promise;
    assert.fail(`Expected ${errorName}`);
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    const rendered = String(error.shortMessage || error.message || error);
    const selector = contract.interface.getError(errorName).selector;
    assert.ok(
      new RegExp(errorName, "i").test(rendered)
        || rendered.toLowerCase().includes(selector.toLowerCase()),
      `Expected ${errorName}; received ${rendered}`
    );
  }
}

async function deploy(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function deploySystem() {
  const [admin, player, buyer, gameSigner, redemptionSigner, vault] = await ethers.getSigners();
  const matt = await deploy("MockMattToken", [admin.address, ethers.parseEther("1000000")]);
  const crystal = await deploy("MockMattCrystal", [admin.address]);
  const miner = await deploy("MattMiner", [admin.address, "ipfs://miners/", "ipfs://miners.json"]);
  const equipment = await deploy("MattEquipment", [
    admin.address,
    "ipfs://equipment/",
    "ipfs://equipment.json"
  ]);
  const randomness = await deploy("MockRandomnessProvider");
  const loadout = await deploy("MattLoadout", [
    admin.address,
    miner.target,
    equipment.target,
    matt.target,
    vault.address,
    ethers.parseEther("0.35"),
    admin.address
  ]);
  const chest = await deploy("MattChest", [
    admin.address,
    matt.target,
    equipment.target,
    randomness.target,
    vault.address,
    admin.address
  ]);
  const settlement = await deploy("MattGameSettlement", [
    admin.address,
    miner.target,
    loadout.target,
    gameSigner.address,
    admin.address,
    admin.address
  ]);
  const redemption = await deploy("MattCrystalRedemption", [
    admin.address,
    crystal.target,
    redemptionSigner.address,
    ethers.parseEther("1000000"),
    ethers.parseEther("3000000"),
    admin.address
  ]);

  await (await equipment.grantRole(MINTER_ROLE, admin.address)).wait();
  await (await equipment.grantRole(MINTER_ROLE, chest.target)).wait();
  await (await equipment.grantRole(LOADOUT_ROLE, loadout.target)).wait();
  await (await equipment.grantRole(STATE_ROLE, loadout.target)).wait();
  await (await equipment.grantRole(BURNER_ROLE, loadout.target)).wait();
  await (await miner.grantRole(PROGRESSION_ROLE, settlement.target)).wait();
  await (await miner.grantRole(METADATA_ROLE, loadout.target)).wait();
  await (await loadout.grantRole(GAME_ROLE, settlement.target)).wait();
  await (await crystal.setMinter(redemption.target, true)).wait();
  await (await miner.mint(player.address)).wait();
  await (await matt.transfer(player.address, ethers.parseEther("1000"))).wait();
  await (await loadout.unpause()).wait();
  await (await chest.unpause()).wait();
  await (await settlement.unpause()).wait();
  await (await redemption.unpause()).wait();

  return {
    admin, player, buyer, gameSigner, redemptionSigner, vault,
    matt, crystal, miner, equipment, randomness, loadout, chest,
    settlement, redemption
  };
}

async function mintEquipment(system, itemType, rarity, definitionId, armorHp) {
  const tokenId = await system.equipment.nextTokenId();
  await (await system.equipment.mintEquipment(
    system.player.address,
    itemType,
    rarity,
    definitionId,
    armorHp
  )).wait();
  return tokenId;
}

async function signRun(system, receipt) {
  const { chainId } = await ethers.provider.getNetwork();
  return system.gameSigner.signTypedData(
    {
      name: "MATT Mine Run Settlement",
      version: "1",
      chainId,
      verifyingContract: system.settlement.target
    },
    {
      RunReceipt: [
        { name: "player", type: "address" },
        { name: "minerId", type: "uint256" },
        { name: "runId", type: "bytes32" },
        { name: "outcome", type: "uint8" },
        { name: "completedPhases", type: "uint8" },
        { name: "xpDelta", type: "uint256" },
        { name: "newLevel", type: "uint8" },
        { name: "crystalsCarried", type: "uint256" },
        { name: "crystalsBanked", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    },
    receipt
  );
}

async function openAndFulfill(system, chestType, randomWord) {
  const requestId = await system.randomness.nextRequestId();
  const tokenId = await system.equipment.nextTokenId();
  await (await system.chest.connect(system.player).openChest(chestType)).wait();
  await (await system.randomness.fulfill(requestId, randomWord)).wait();
  return system.equipment.equipmentData(tokenId);
}

describe("MATT Mine NFT system", function () {
  it("advertises the ERC-4906 metadata refresh interface", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);

    assert.equal(await system.miner.supportsInterface("0x49064906"), true);
    assert.equal(await system.equipment.supportsInterface("0x49064906"), true);
  });

  it("keeps equipped NFTs attached to the Miner when it is sold", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const weaponId = await mintEquipment(system, 0, 0, 101, 0);
    await (await system.equipment.connect(system.player).approve(system.loadout.target, weaponId)).wait();
    await (await system.loadout.connect(system.player).equip(1n, weaponId)).wait();

    assert.equal(await system.equipment.ownerOf(weaponId), system.loadout.target);
    await (await system.miner.connect(system.player).transferFrom(
      system.player.address,
      system.buyer.address,
      1n
    )).wait();

    await expectCustomError(
      system.loadout.connect(system.player).unequip(1n, weaponId, 0n),
      system.loadout,
      "NotMinerOwner"
    );
    await (await system.loadout.connect(system.buyer).unequip(1n, weaponId, 0n)).wait();
    assert.equal(await system.equipment.ownerOf(weaponId), system.buyer.address);
  });

  it("burns the active backpack, promotes the next, damages armor, and requires paid repair", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const armorId = await mintEquipment(system, 3, 1, 401, 150);
    const backpackOne = await mintEquipment(system, 1, 0, 201, 0);
    const backpackTwo = await mintEquipment(system, 1, 0, 201, 0);
    for (const tokenId of [armorId, backpackOne, backpackTwo]) {
      await (await system.equipment.connect(system.player).approve(system.loadout.target, tokenId)).wait();
      await (await system.loadout.connect(system.player).equip(1n, tokenId)).wait();
    }

    const now = BigInt(await networkHelpers.time.latest());
    const death = {
      player: system.player.address,
      minerId: 1n,
      runId: ethers.id("death-run"),
      outcome: 1,
      completedPhases: 31,
      xpDelta: 0n,
      newLevel: 1,
      crystalsCarried: 101n,
      crystalsBanked: 50n,
      nonce: 0n,
      deadline: now + 3600n
    };
    await (await system.settlement.beginRun(1n)).wait();
    await (await system.settlement.connect(system.player).settleRun(death, await signRun(system, death))).wait();

    await assert.rejects(system.equipment.ownerOf(backpackOne));
    assert.equal(await system.loadout.activeBackpack(1n), backpackTwo);
    assert.equal((await system.equipment.equipmentData(armorId)).damaged, true);
    assert.equal(await system.loadout.effectiveHitPoints(1n), 100n);

    const price = await system.loadout.repairPrice();
    await (await system.matt.connect(system.player).approve(system.loadout.target, price)).wait();
    const vaultBefore = await system.matt.balanceOf(system.vault.address);
    await (await system.loadout.connect(system.player).repairArmor(1n)).wait();
    assert.equal((await system.equipment.equipmentData(armorId)).damaged, false);
    assert.equal(await system.loadout.effectiveHitPoints(1n), 150n);
    assert.equal(await system.matt.balanceOf(system.vault.address), vaultBefore + price);
  });

  it("locks phase XP to the five-phase table and keeps loadouts frozen during a run", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    assert.equal(await system.settlement.xpForCompletedPhases(1), 10n);
    assert.equal(await system.settlement.xpForCompletedPhases(3), 22n);
    assert.equal(await system.settlement.xpForCompletedPhases(31), 80n);

    const helmetId = await mintEquipment(system, 2, 0, 301, 0);
    await (await system.equipment.connect(system.player).approve(system.loadout.target, helmetId)).wait();
    await (await system.settlement.beginRun(1n)).wait();
    await expectCustomError(
      system.loadout.connect(system.player).equip(1n, helmetId),
      system.loadout,
      "MinerInRun"
    );
    await (await system.settlement.cancelRun(1n)).wait();
  });

  it("escrows chest MATT until randomness fulfills and mints the locked rare-armor outcome", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const price = ethers.parseEther("5");
    await (await system.chest.setChestPrice(3, price)).wait();
    await (await system.chest.setDefinitionPool(3, 4, [999])).wait();
    await (await system.matt.connect(system.player).approve(system.chest.target, price)).wait();

    const vaultBefore = await system.matt.balanceOf(system.vault.address);
    await (await system.chest.connect(system.player).openChest(3)).wait();
    assert.equal(await system.matt.balanceOf(system.vault.address), vaultBefore);
    await (await system.randomness.fulfill(1n, 9_999n)).wait();

    const item = await system.equipment.equipmentData(1n);
    assert.equal(item.armorHp, 200n);
    assert.equal(item.rarity, 4n);
    assert.equal(await system.equipment.ownerOf(1n), system.player.address);
    assert.equal(await system.matt.balanceOf(system.vault.address), vaultBefore + price);
  });

  it("matches the locked weapon and armor probability boundaries", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    for (let rarity = 0; rarity <= 4; rarity += 1) {
      await (await system.chest.setDefinitionPool(0, rarity, [100 + rarity])).wait();
      await (await system.chest.setDefinitionPool(3, rarity, [400 + rarity])).wait();
    }
    for (const [roll, expected] of [[5_999n, 0n], [6_000n, 1n], [8_000n, 2n], [9_200n, 3n], [9_900n, 4n]]) {
      const item = await openAndFulfill(system, 0, roll);
      assert.equal(item.rarity, expected);
    }
    for (const [roll, rarity, hp] of [[4_999n, 0n, 125n], [5_000n, 1n, 150n], [8_000n, 2n, 175n], [9_200n, 3n, 195n], [9_800n, 4n, 200n]]) {
      const item = await openAndFulfill(system, 3, roll);
      assert.equal(item.rarity, rarity);
      assert.equal(item.armorHp, hp);
    }
  });

  it("redeems signed Crystals and enforces the adjustable daily maximum", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const { chainId } = await ethers.provider.getNetwork();
    const now = BigInt(await networkHelpers.time.latest());
    const types = {
      RedemptionReceipt: [
        { name: "player", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    };
    const domain = {
      name: "MATT Crystal Redemption",
      version: "1",
      chainId,
      verifyingContract: system.redemption.target
    };
    const receipt = {
      player: system.player.address,
      amount: ethers.parseEther("1000000"),
      nonce: 0n,
      deadline: now + 3600n
    };
    const signature = await system.redemptionSigner.signTypedData(domain, types, receipt);
    await (await system.redemption.connect(system.player).redeem(receipt, signature)).wait();
    assert.equal(await system.crystal.balanceOf(system.player.address), receipt.amount);

    const overLimit = { ...receipt, amount: ethers.parseEther("3000000"), nonce: 1n };
    const overSignature = await system.redemptionSigner.signTypedData(domain, types, overLimit);
    await expectCustomError(
      system.redemption.connect(system.player).redeem(overLimit, overSignature),
      system.redemption,
      "DailyLimitExceeded"
    );
  });

  it("delivers randomness through the dedicated Ronin VRF V2.5 adapter", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const coordinator = await deploy("MockVRFCoordinatorV25");
    const adapter = await deploy("MattMineVRFV25Adapter", [
      coordinator.target,
      1n,
      ethers.id("ronin-vrf-key"),
      system.admin.address,
      3,
      1_400_000,
      1_000_000
    ]);
    await (await adapter.setConsumer(system.chest.target)).wait();
    await (await system.chest.setRandomnessConfiguration(adapter.target, 86_400n)).wait();
    await (await system.chest.setDefinitionPool(0, 4, [1005])).wait();

    await (await system.chest.connect(system.player).openChest(0)).wait();
    assert.equal(await adapter.outstandingRequests(), 1n);
    await (await coordinator.fulfill(1n, 9_999n)).wait();
    const item = await system.equipment.equipmentData(1n);
    assert.equal(item.rarity, 4n);
    assert.equal(item.definitionId, 1005n);
    assert.equal(await adapter.outstandingRequests(), 0n);
  });

  it("keeps every Saigon test dependency under the approved admin and oracle", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const testMatt = await deploy("MattMineSaigonMatt", [
      system.admin.address,
      ethers.parseEther("1000000000")
    ]);
    const testCrystal = await deploy("MattMineSaigonCrystal", [system.admin.address]);
    const randomness = await deploy("MattMineSaigonRandomness", [
      system.admin.address,
      system.gameSigner.address
    ]);

    assert.equal(await testMatt.owner(), system.admin.address);
    assert.equal(await testCrystal.owner(), system.admin.address);
    assert.equal(await randomness.owner(), system.admin.address);
    assert.equal(await randomness.oracle(), system.gameSigner.address);

    await (await system.chest.setRandomnessConfiguration(randomness.target, 86_400n)).wait();
    await (await system.chest.setDefinitionPool(0, 4, [105])).wait();
    await (await system.chest.connect(system.player).openChest(0)).wait();
    await expectCustomError(
      randomness.connect(system.player).fulfill(1n, 9_999n),
      randomness,
      "Unauthorized"
    );
    await (await randomness.connect(system.gameSigner).fulfill(1n, 9_999n)).wait();
    assert.equal((await system.equipment.equipmentData(1n)).definitionId, 105n);
  });
});
