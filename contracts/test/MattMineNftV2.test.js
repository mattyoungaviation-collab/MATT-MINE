import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const role = (name) => ethers.id(name);
const MINTER_ROLE = role("MINTER_ROLE");
const PROGRESSION_ROLE = role("PROGRESSION_ROLE");
const LOCK_ROLE = role("LOCK_ROLE");
const PASSIVE_ROLE = role("PASSIVE_ROLE");
const METADATA_ROLE = role("METADATA_ROLE");
const LOADOUT_ROLE = role("LOADOUT_ROLE");
const STATE_ROLE = role("STATE_ROLE");
const BURNER_ROLE = role("BURNER_ROLE");
const GAME_ROLE = role("GAME_ROLE");
const CREDIT_ROLE = role("CREDIT_ROLE");
const SETTLEMENT_ROLE = role("SETTLEMENT_ROLE");
const OPERATOR_ROLE = role("OPERATOR_ROLE");

const SLOT = {
  Armor: 0,
  Pickaxe: 1,
  Blaster: 2,
  Dynamite: 3,
  Helmet: 4,
  Backpack: 5
};

const RARITY = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Mythic: 3,
  Legendary: 4
};

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

async function deployProxy(name, timelock, initializeArgs) {
  const implementation = await deploy(name, [timelock.target]);
  const initializationData = implementation.interface.encodeFunctionData("initialize", initializeArgs);
  const proxy = await deploy("MattV2ERC1967Proxy", [implementation.target, initializationData]);
  return {
    implementation,
    proxy,
    contract: await ethers.getContractAt(name, proxy.target)
  };
}

async function deploySystem() {
  const [
    admin,
    player,
    buyer,
    gameOperator,
    rewardSigner,
    keeper,
    treasury,
    pauser,
    outsider
  ] = await ethers.getSigners();

  const matt = await deploy("MockMattToken", [admin.address, ethers.parseEther("1000000000")]);
  const crystal = await deploy("MockMattCrystal", [admin.address]);
  const timelock = await deploy("MattV2UpgradeTimelock", [admin.address]);
  const miner = await deploy("MattV2Miner", [
    admin.address,
    treasury.address,
    "https://matt-mine.example/miners/",
    "ipfs://miners-contract"
  ]);
  const equipment = await deploy("MattV2Equipment", [
    admin.address,
    treasury.address,
    "https://matt-mine.example/equipment/",
    "ipfs://equipment-contract"
  ]);
  const loadout = await deploy("MattV2Loadout", [
    admin.address,
    miner.target,
    equipment.target,
    matt.target,
    treasury.address,
    ethers.parseEther("1")
  ]);
  const chestRandomness = await deploy("MockRandomnessProvider");
  const passiveRandomness = await deploy("MockRandomnessProvider");

  const bankDeployment = await deployProxy("MattV2CrystalBank", timelock, [
    admin.address,
    pauser.address,
    admin.address,
    admin.address,
    crystal.target
  ]);
  const bank = bankDeployment.contract;

  const passiveDeployment = await deployProxy("MattV2PassiveRewards", timelock, [
    admin.address,
    pauser.address,
    admin.address,
    keeper.address,
    miner.target,
    crystal.target,
    passiveRandomness.target
  ]);
  const passive = passiveDeployment.contract;

  const settlementDeployment = await deployProxy("MattV2GameSettlement", timelock, [
    admin.address,
    pauser.address,
    gameOperator.address,
    admin.address,
    rewardSigner.address,
    miner.target,
    loadout.target,
    bank.target,
    passive.target
  ]);
  const settlement = settlementDeployment.contract;

  const endlessSettlementDeployment = await deployProxy("MattV2EndlessSettlement", timelock, [
    admin.address,
    pauser.address,
    gameOperator.address,
    admin.address,
    rewardSigner.address,
    miner.target,
    loadout.target,
    bank.target,
    passive.target
  ]);
  const endlessSettlement = endlessSettlementDeployment.contract;

  const chestDeployment = await deployProxy("MattV2Chest", timelock, [
    admin.address,
    pauser.address,
    admin.address,
    matt.target,
    equipment.target,
    chestRandomness.target,
    treasury.address
  ]);
  const chest = chestDeployment.contract;

  await (await miner.grantRole(PROGRESSION_ROLE, settlement.target)).wait();
  await (await miner.grantRole(LOCK_ROLE, settlement.target)).wait();
  await (await miner.grantRole(PROGRESSION_ROLE, endlessSettlement.target)).wait();
  await (await miner.grantRole(LOCK_ROLE, endlessSettlement.target)).wait();
  await (await miner.grantRole(PASSIVE_ROLE, passive.target)).wait();
  await (await miner.grantRole(METADATA_ROLE, loadout.target)).wait();

  await (await equipment.grantRole(MINTER_ROLE, chest.target)).wait();
  await (await equipment.grantRole(LOADOUT_ROLE, loadout.target)).wait();
  await (await equipment.grantRole(STATE_ROLE, loadout.target)).wait();
  await (await equipment.grantRole(BURNER_ROLE, loadout.target)).wait();

  await (await loadout.grantRole(GAME_ROLE, settlement.target)).wait();
  await (await loadout.grantRole(GAME_ROLE, endlessSettlement.target)).wait();
  await (await bank.grantRole(CREDIT_ROLE, settlement.target)).wait();
  await (await bank.grantRole(CREDIT_ROLE, endlessSettlement.target)).wait();
  await (await passive.grantRole(SETTLEMENT_ROLE, settlement.target)).wait();
  await (await passive.grantRole(SETTLEMENT_ROLE, endlessSettlement.target)).wait();
  await (await crystal.setMinter(bank.target, true)).wait();
  await (await crystal.setMinter(passive.target, true)).wait();

  for (let slot = 0; slot < 6; slot += 1) {
    const price = slot === SLOT.Armor || slot === SLOT.Backpack
      ? ethers.parseEther("5")
      : ethers.parseEther("2");
    await (await chest.setChestPrice(slot, price)).wait();
    for (let rarity = 0; rarity < 5; rarity += 1) {
      await (await chest.configureDefinitionPool(1, slot, rarity, [slot * 100 + rarity + 1])).wait();
    }
  }
  await (await chest.activateDefinitionVersion(1)).wait();

  const mapArgs = [
    ethers.id("MATT_MINE_MAP_1"),
    ethers.id("MATT_MINE_MAP_1_CONTENT_V1"),
    5_000,
    ethers.parseEther("0.01"),
    ethers.parseEther("100000"),
    2 * 60 * 60
  ];
  const mapVersion = await settlement.approveMapVersion.staticCall(...mapArgs);
  await (await settlement.approveMapVersion(...mapArgs)).wait();

  await (await miner.unpauseMinting()).wait();
  await (await equipment.unpauseMinting()).wait();
  await (await loadout.unpause()).wait();
  await (await bank.unpause()).wait();
  await (await passive.unpause()).wait();
  await (await settlement.unpause()).wait();
  await (await endlessSettlement.unpause()).wait();
  await (await chest.unpause()).wait();

  await (await miner.mint(player.address)).wait();
  await (await matt.transfer(player.address, ethers.parseEther("10000"))).wait();

  return {
    admin,
    player,
    buyer,
    gameOperator,
    rewardSigner,
    keeper,
    treasury,
    pauser,
    outsider,
    matt,
    crystal,
    timelock,
    miner,
    equipment,
    loadout,
    chestRandomness,
    passiveRandomness,
    bank,
    bankImplementation: bankDeployment.implementation,
    passive,
    passiveImplementation: passiveDeployment.implementation,
    settlement,
    settlementImplementation: settlementDeployment.implementation,
    endlessSettlement,
    endlessSettlementImplementation: endlessSettlementDeployment.implementation,
    chest,
    chestImplementation: chestDeployment.implementation,
    mapVersion
  };
}

async function mintEquipment(system, slot, rarity, definitionId) {
  const tokenId = await system.equipment.nextTokenId();
  await (await system.equipment.mintEquipment(
    system.player.address,
    slot,
    rarity,
    definitionId
  )).wait();
  return tokenId;
}

async function signRunAuthorization(system, overrides = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  const loadoutHash = await system.loadout.loadoutHash(1n);
  const latest = await ethers.provider.getBlock("latest");
  const authorization = {
    player: system.player.address,
    minerId: 1n,
    mapVersion: system.mapVersion,
    loadoutHash,
    nonce: await system.settlement.playerNonces(system.player.address),
    deadline: BigInt(latest.timestamp + 3600),
    ...overrides
  };
  const signature = await system.player.signTypedData(
    {
      name: "MATT Mine V2 Run Settlement",
      version: "2",
      chainId,
      verifyingContract: system.settlement.target
    },
    {
      RunAuthorization: [
        { name: "player", type: "address" },
        { name: "minerId", type: "uint256" },
        { name: "mapVersion", type: "bytes32" },
        { name: "loadoutHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    },
    authorization
  );
  return { authorization, signature };
}

async function beginRun(system) {
  const { authorization, signature } = await signRunAuthorization(system);
  await (await system.settlement.connect(system.gameOperator).beginRun(authorization, signature)).wait();
  return system.settlement.activeRun(1n);
}

async function signRunResult(system, active, overrides = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  const latest = await ethers.provider.getBlock("latest");
  const result = {
    player: system.player.address,
    minerId: 1n,
    runId: active.runId,
    mapVersion: active.mapVersion,
    loadoutHash: active.loadoutHash,
    outcome: 0,
    completedPhases: 5,
    minedCrystalUnits: 1_000,
    nonce: active.nonce,
    deadline: BigInt(latest.timestamp + 3600),
    ...overrides
  };
  const signature = await system.rewardSigner.signTypedData(
    {
      name: "MATT Mine V2 Run Settlement",
      version: "2",
      chainId,
      verifyingContract: system.settlement.target
    },
    {
      RunResult: [
        { name: "player", type: "address" },
        { name: "minerId", type: "uint256" },
        { name: "runId", type: "bytes32" },
        { name: "mapVersion", type: "bytes32" },
        { name: "loadoutHash", type: "bytes32" },
        { name: "outcome", type: "uint8" },
        { name: "completedPhases", type: "uint8" },
        { name: "minedCrystalUnits", type: "uint32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    },
    result
  );
  return { result, signature };
}

const ENDLESS_DOMAIN = (system, chainId) => ({
  name: "MATT Mine V2 Endless Settlement",
  version: "1",
  chainId,
  verifyingContract: system.endlessSettlement.target
});

async function beginEndlessRun(system, versionId) {
  const { chainId } = await ethers.provider.getNetwork();
  const latest = await ethers.provider.getBlock("latest");
  const authorization = {
    player: system.player.address,
    minerId: 1n,
    versionId,
    loadoutHash: await system.loadout.loadoutHash(1n),
    nonce: await system.endlessSettlement.playerNonces(system.player.address),
    deadline: BigInt(latest.timestamp + 3600)
  };
  const signature = await system.player.signTypedData(ENDLESS_DOMAIN(system, chainId), {
    EndlessRunAuthorization: [
      { name: "player", type: "address" },
      { name: "minerId", type: "uint256" },
      { name: "versionId", type: "bytes32" },
      { name: "loadoutHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  }, authorization);
  await (await system.endlessSettlement.connect(system.gameOperator).beginRun(authorization, signature)).wait();
  return system.endlessSettlement.activeRun(1n);
}

async function signEndlessCheckpoint(system, active, values) {
  const { chainId } = await ethers.provider.getNetwork();
  const latest = await ethers.provider.getBlock("latest");
  const receipt = {
    player: system.player.address,
    minerId: 1n,
    runId: active.runId,
    versionId: active.versionId,
    previousDigest: values.previousDigest,
    checkpointDigest: values.checkpointDigest,
    completedPhases: values.completedPhases,
    minedCrystalUnits: values.minedCrystalUnits,
    nonce: active.nonce,
    deadline: BigInt(latest.timestamp + 3600)
  };
  const signature = await system.rewardSigner.signTypedData(ENDLESS_DOMAIN(system, chainId), {
    EndlessCheckpoint: [
      { name: "player", type: "address" },
      { name: "minerId", type: "uint256" },
      { name: "runId", type: "bytes32" },
      { name: "versionId", type: "bytes32" },
      { name: "previousDigest", type: "bytes32" },
      { name: "checkpointDigest", type: "bytes32" },
      { name: "completedPhases", type: "uint32" },
      { name: "minedCrystalUnits", type: "uint32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  }, receipt);
  return { receipt, signature };
}

async function signEndlessResult(system, active, values) {
  const { chainId } = await ethers.provider.getNetwork();
  const latest = await ethers.provider.getBlock("latest");
  const result = {
    player: system.player.address,
    minerId: 1n,
    runId: active.runId,
    versionId: active.versionId,
    checkpointDigest: values.checkpointDigest,
    outcome: values.outcome ?? 0,
    completedPhases: values.completedPhases,
    minedCrystalUnits: values.minedCrystalUnits,
    nonce: active.nonce,
    deadline: BigInt(latest.timestamp + 3600)
  };
  const signature = await system.rewardSigner.signTypedData(ENDLESS_DOMAIN(system, chainId), {
    EndlessResult: [
      { name: "player", type: "address" },
      { name: "minerId", type: "uint256" },
      { name: "runId", type: "bytes32" },
      { name: "versionId", type: "bytes32" },
      { name: "checkpointDigest", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "completedPhases", type: "uint32" },
      { name: "minedCrystalUnits", type: "uint32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  }, result);
  return { result, signature };
}

describe("MATT Mine NFT V2", function () {
  it("locks every phase, rarity, equipment, and XP boundary in immutable math", async function () {
    const math = await deploy("MattV2MathHarness");
    assert.deepEqual(
      await Promise.all([0, 1, 2, 3, 4, 5].map((phases) => math.xpForPhases(phases))),
      [0n, 10n, 25n, 45n, 70n, 100n]
    );
    assert.equal(await math.xpThreshold(1), 0n);
    assert.equal(await math.xpThreshold(100), 360_000n);
    for (let level = 1; level <= 100; level += 1) {
      const threshold = await math.xpThreshold(level);
      assert.equal(await math.levelForXp(threshold), BigInt(level));
      if (level > 1) assert.equal(await math.levelForXp(threshold - 1n), BigInt(level - 1));
    }
    assert.deepEqual(
      await Promise.all([0, 6_799, 6_800, 8_599, 8_600, 9_399, 9_400, 9_899, 9_900, 9_999]
        .map((word) => math.rollRarity(word))),
      [0n, 0n, 1n, 1n, 2n, 2n, 3n, 3n, 4n, 4n]
    );
    assert.equal(await math.equipmentBonus(SLOT.Armor, RARITY.Legendary), 150n);
    assert.equal(await math.equipmentBonus(SLOT.Backpack, RARITY.Legendary), 15_000n);
    assert.equal(await math.equipmentBonus(SLOT.Dynamite, RARITY.Legendary), 25n);
    for (const [word, minimum, maximum] of [
      [0, 5, 9],
      [1_000, 10, 19],
      [4_500, 20, 30],
      [8_500, 31, 39],
      [9_500, 40, 49],
      [9_900, 50, 50]
    ]) {
      const rolled = await math.rollCrystalsPerHour(word);
      assert.ok(rolled >= minimum && rolled <= maximum);
    }
  });

  it("locks the 1,000 supply, royalties, metadata interface, and exact level traits", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    assert.equal(await system.miner.MAX_SUPPLY(), 1_000n);
    assert.equal(await system.miner.supportsInterface("0x49064906"), true);
    assert.equal(await system.equipment.supportsInterface("0x49064906"), true);
    const royalty = await system.miner.royaltyInfo(1n, 10_000n);
    assert.equal(royalty[0], system.treasury.address);
    assert.equal(royalty[1], 500n);

    const levelOne = await system.miner.traitsOf(1n);
    assert.equal(levelOne.level, 1n);
    assert.equal(levelOne.baseHealth, 50n);
    assert.equal(levelOne.pickaxeAttack, 15n);
    assert.equal(levelOne.blasterAttack, 5n);
    assert.equal(levelOne.dynamiteAttack, 20n);
    assert.equal(levelOne.healAmount, 10n);
    assert.equal(levelOne.baseCarryCapacity, 750n);
    assert.equal(levelOne.deathRetentionBps, 1_000n);
    assert.equal(levelOne.earningStatus, 0n);

    await (await system.miner.applyXp(1n, 360_000n)).wait();
    const levelHundred = await system.miner.traitsOf(1n);
    assert.equal(levelHundred.level, 100n);
    assert.equal(levelHundred.baseHealth, 150n);
    assert.equal(levelHundred.pickaxeAttack, 35n);
    assert.equal(levelHundred.blasterAttack, 30n);
    assert.equal(levelHundred.dynamiteAttack, 80n);
    assert.equal(levelHundred.healAmount, 50n);
    assert.equal(levelHundred.baseCarryCapacity, 1_500n);
    assert.equal(levelHundred.deathRetentionBps, 5_000n);
  });

  it("applies fixed gear bonuses and keeps equipped custody attached through a Miner sale", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const armor = await mintEquipment(system, SLOT.Armor, RARITY.Legendary, 1001);
    const backpack = await mintEquipment(system, SLOT.Backpack, RARITY.Legendary, 2001);
    const pickaxe = await mintEquipment(system, SLOT.Pickaxe, RARITY.Legendary, 3001);
    await expectCustomError(
      system.equipment.connect(system.player).transferFrom(
        system.player.address,
        system.loadout.target,
        armor
      ),
      system.equipment,
      "DirectCustodyTransferForbidden"
    );
    for (const tokenId of [armor, backpack, pickaxe]) {
      await (await system.equipment.connect(system.player).approve(system.loadout.target, tokenId)).wait();
      await (await system.loadout.connect(system.player).equip(1n, tokenId)).wait();
      assert.equal(await system.equipment.ownerOf(tokenId), system.loadout.target);
    }

    const traits = await system.loadout.effectiveTraits(1n);
    assert.equal(traits.armorShield, 150n);
    assert.equal(traits.pickaxeAttack, 25n);
    assert.equal(traits.carryCapacity, 1_875n);

    await (await system.miner.connect(system.player).transferFrom(
      system.player.address,
      system.buyer.address,
      1n
    )).wait();
    await expectCustomError(
      system.loadout.connect(system.player).unequip(1n, SLOT.Pickaxe),
      system.loadout,
      "NotMinerOwner"
    );
    await (await system.loadout.connect(system.buyer).unequip(1n, SLOT.Pickaxe)).wait();
    assert.equal(await system.equipment.ownerOf(pickaxe), system.buyer.address);
  });

  it("requires player authorization plus an independent reward signature and settles extraction", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const active = await beginRun(system);
    assert.equal(await system.miner.isRunLocked(1n), true);

    const { result, signature } = await signRunResult(system, active, {
      outcome: 0,
      completedPhases: 5,
      minedCrystalUnits: 1_000
    });
    await expectCustomError(
      system.settlement.connect(system.outsider).settleRun(result, signature),
      system.settlement,
      "AccessControlUnauthorizedAccount"
    );
    await (await system.settlement.connect(system.gameOperator).settleRun(result, signature)).wait();

    const progression = await system.miner.progressionOf(1n);
    assert.equal(progression.bankedXp, 100n);
    assert.equal(await system.bank.bankBalance(system.player.address), ethers.parseEther("7.5"));
    assert.equal(await system.miner.isRunLocked(1n), false);
    await expectCustomError(
      system.settlement.connect(system.gameOperator).settleRun(result, signature),
      system.settlement,
      "RunNotActive"
    );
  });

  it("configures XP per phase per map and snapshots it when the run begins", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    await (await system.settlement.setMapPhaseXp(system.mapVersion, [20, 30, 40, 50, 60])).wait();
    const active = await beginRun(system);
    await (await system.settlement.setMapPhaseXp(system.mapVersion, [10, 10, 10, 10, 10])).wait();
    const { result, signature } = await signRunResult(system, active, {
      outcome: 0,
      completedPhases: 5,
      minedCrystalUnits: 1
    });
    await (await system.settlement.connect(system.gameOperator).settleRun(result, signature)).wait();
    assert.equal((await system.miner.progressionOf(1n)).bankedXp, 200n);
    assert.deepEqual((await system.settlement.phaseXpForMap(system.mapVersion)).map(Number), [10, 10, 10, 10, 10]);
    await expectCustomError(
      system.settlement.setMapPhaseXp(system.mapVersion, [100, 100, 100, 100, 101]),
      system.settlement,
      "InvalidConfiguration"
    );
  });

  it("settles chained Endless checkpoints beyond five phases with frozen XP and emission caps", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const version = {
      generatorHash: ethers.id("endless-map-v1"),
      configHash: ethers.id("endless-config-v1"),
      conversionRate: ethers.parseEther("0.01"),
      maximumPayout: ethers.parseEther("100000"),
      maximumDailyPayout: ethers.parseEther("1000000"),
      mineableCrystalUnits: 5_000,
      maximumPhases: 10_000,
      phaseXp: 25,
      maximumRunXp: 140,
      maximumWalletXpPerDay: 1_000,
      maximumMinerXpPerDay: 1_000,
      checkpointTimeout: 2 * 60 * 60,
      failedRunsRetainXp: false,
      approved: false,
      retired: false
    };
    const versionId = await system.endlessSettlement.approveVersion.staticCall(version);
    await (await system.endlessSettlement.approveVersion(version)).wait();
    const active = await beginEndlessRun(system, versionId);
    assert.equal(await system.miner.isRunLocked(1n), true);

    let previousDigest = ethers.ZeroHash;
    for (let phase = 1; phase <= 6; phase += 1) {
      const checkpointDigest = ethers.id(`endless-checkpoint-${phase}`);
      const signed = await signEndlessCheckpoint(system, active, {
        previousDigest,
        checkpointDigest,
        completedPhases: phase,
        minedCrystalUnits: phase
      });
      await (await system.endlessSettlement.connect(system.gameOperator).checkpoint(
        signed.receipt,
        signed.signature
      )).wait();
      previousDigest = checkpointDigest;
    }
    const progress = await system.endlessSettlement.activeRun(1n);
    assert.equal(progress.completedPhases, 6n);
    assert.equal(progress.checkpointDigest, previousDigest);

    const signedResult = await signEndlessResult(system, active, {
      checkpointDigest: previousDigest,
      completedPhases: 6,
      minedCrystalUnits: 6
    });
    await (await system.endlessSettlement.connect(system.gameOperator).settle(
      signedResult.result,
      signedResult.signature
    )).wait();
    assert.equal((await system.miner.progressionOf(1n)).bankedXp, 140n);
    assert.equal(await system.bank.bankBalance(system.player.address), ethers.parseEther("0.06"));
    assert.equal(await system.miner.isRunLocked(1n), false);
  });

  it("releases only an uncheckpointed Endless start without rewards or death effects", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const version = {
      generatorHash: ethers.id("endless-map-v1"),
      configHash: ethers.id("endless-cancel-v1"),
      conversionRate: ethers.parseEther("0.0025"),
      maximumPayout: ethers.parseEther("10"),
      maximumDailyPayout: ethers.parseEther("500"),
      mineableCrystalUnits: 3_750,
      maximumPhases: 1_000_000,
      phaseXp: 10,
      maximumRunXp: 500,
      maximumWalletXpPerDay: 2_500,
      maximumMinerXpPerDay: 2_500,
      checkpointTimeout: 86_400,
      failedRunsRetainXp: false,
      approved: false,
      retired: false
    };
    const versionId = await system.endlessSettlement.approveVersion.staticCall(version);
    await (await system.endlessSettlement.approveVersion(version)).wait();
    const active = await beginEndlessRun(system, versionId);
    const before = await system.miner.traitsOf(1n);

    const cancelled = await signEndlessResult(system, active, {
      checkpointDigest: ethers.ZeroHash,
      outcome: 1,
      completedPhases: 0,
      minedCrystalUnits: 0
    });
    await expectCustomError(
      system.endlessSettlement.connect(system.outsider).settle(cancelled.result, cancelled.signature),
      system.endlessSettlement,
      "AccessControlUnauthorizedAccount"
    );
    await (await system.endlessSettlement.connect(system.gameOperator).settle(
      cancelled.result,
      cancelled.signature
    )).wait();

    const after = await system.miner.traitsOf(1n);
    assert.equal(await system.miner.isRunLocked(1n), false);
    assert.equal(await system.endlessSettlement.processedRuns(active.runId), true);
    assert.equal(after.bankedXp, before.bankedXp);
    assert.equal(await system.bank.bankBalance(system.player.address), 0n);
  });

  it("freezes Miner transfer and loadout mutation for the exact active run snapshot", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const pickaxe = await mintEquipment(system, SLOT.Pickaxe, RARITY.Common, 7001);
    await (await system.equipment.connect(system.player).approve(system.loadout.target, pickaxe)).wait();
    await beginRun(system);
    await expectCustomError(
      system.miner.connect(system.player).transferFrom(system.player.address, system.buyer.address, 1n),
      system.miner,
      "MinerRunLocked"
    );
    await expectCustomError(
      system.loadout.connect(system.player).equip(1n, pickaxe),
      system.loadout,
      "MinerInRun"
    );
  });

  it("rejects forged reward results and maps beyond immutable economic ceilings", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const active = await beginRun(system);
    const { result } = await signRunResult(system, active);
    const { chainId } = await ethers.provider.getNetwork();
    const forged = await system.outsider.signTypedData(
      {
        name: "MATT Mine V2 Run Settlement",
        version: "2",
        chainId,
        verifyingContract: system.settlement.target
      },
      {
        RunResult: [
          { name: "player", type: "address" },
          { name: "minerId", type: "uint256" },
          { name: "runId", type: "bytes32" },
          { name: "mapVersion", type: "bytes32" },
          { name: "loadoutHash", type: "bytes32" },
          { name: "outcome", type: "uint8" },
          { name: "completedPhases", type: "uint8" },
          { name: "minedCrystalUnits", type: "uint32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      },
      result
    );
    await expectCustomError(
      system.settlement.connect(system.gameOperator).settleRun(result, forged),
      system.settlement,
      "InvalidSignature"
    );
    await expectCustomError(
      system.settlement.approveMapVersion(
        ethers.id("bad-map"),
        ethers.id("bad-map-content"),
        1,
        ethers.parseEther("100001"),
        ethers.parseEther("100000"),
        7_200
      ),
      system.settlement,
      "InvalidConfiguration"
    );
  });

  it("damages Armor, burns Backpack, loses run XP, and applies level-based death retention", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const armor = await mintEquipment(system, SLOT.Armor, RARITY.Rare, 4001);
    const backpack = await mintEquipment(system, SLOT.Backpack, RARITY.Legendary, 5001);
    await expectCustomError(system.loadout.applyDeath(1n), system.loadout, "MinerNotInRun");
    await expectCustomError(
      system.equipment.setArmorDamaged(armor, true),
      system.equipment,
      "AssignmentMismatch"
    );
    await expectCustomError(
      system.equipment.burnEquipped(backpack),
      system.equipment,
      "AssignmentMismatch"
    );
    for (const tokenId of [armor, backpack]) {
      await (await system.equipment.connect(system.player).approve(system.loadout.target, tokenId)).wait();
      await (await system.loadout.connect(system.player).equip(1n, tokenId)).wait();
    }
    const active = await beginRun(system);
    const { result, signature } = await signRunResult(system, active, {
      outcome: 1,
      completedPhases: 4,
      minedCrystalUnits: 1_000
    });
    await (await system.settlement.connect(system.gameOperator).settleRun(result, signature)).wait();

    const armorData = await system.equipment.equipmentData(armor);
    assert.equal(armorData.damaged, true);
    await assert.rejects(system.equipment.ownerOf(backpack));
    assert.equal((await system.miner.progressionOf(1n)).bankedXp, 0n);
    assert.equal(await system.bank.bankBalance(system.player.address), ethers.parseEther("1"));
    assert.equal((await system.loadout.effectiveTraits(1n)).armorShield, 0n);

    await (await system.matt.connect(system.player).approve(system.loadout.target, ethers.parseEther("1"))).wait();
    await (await system.loadout.connect(system.player).repairArmor(1n)).wait();
    assert.equal((await system.equipment.equipmentData(armor)).damaged, false);
  });

  it("lets the owner force-abandon after timeout with death consequences and no activity credit", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const backpack = await mintEquipment(system, SLOT.Backpack, RARITY.Common, 6001);
    await (await system.equipment.connect(system.player).approve(system.loadout.target, backpack)).wait();
    await (await system.loadout.connect(system.player).equip(1n, backpack)).wait();
    await beginRun(system);
    await expectCustomError(
      system.settlement.connect(system.player).forceAbandon(1n),
      system.settlement,
      "ForceAbandonTooEarly"
    );
    await networkHelpers.time.increase(2 * 60 * 60);
    await (await system.settlement.connect(system.player).forceAbandon(1n)).wait();
    assert.equal(await system.miner.isRunLocked(1n), false);
    assert.equal((await system.miner.progressionOf(1n)).lastVerifiedPlay, 0n);
    await assert.rejects(system.equipment.ownerOf(backpack));
  });

  it("escrows chest MATT, fulfills the fixed rarity odds, and refunds expired requests", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    await (await system.matt.connect(system.player).approve(system.chest.target, ethers.parseEther("20"))).wait();
    const treasuryBefore = await system.matt.balanceOf(system.treasury.address);
    const requestId = await system.chestRandomness.nextRequestId();
    await (await system.chest.connect(system.player).openChest(SLOT.Pickaxe)).wait();
    assert.equal(await system.matt.balanceOf(system.chest.target), ethers.parseEther("2"));
    assert.equal(await system.matt.balanceOf(system.treasury.address), treasuryBefore);
    await (await system.chestRandomness.fulfill(requestId, 9_950)).wait();
    const minted = await system.equipment.equipmentData(1n);
    assert.equal(minted.slot, BigInt(SLOT.Pickaxe));
    assert.equal(minted.rarity, BigInt(RARITY.Legendary));
    assert.equal(await system.matt.balanceOf(system.chest.target), 0n);
    assert.equal(await system.matt.balanceOf(system.treasury.address), treasuryBefore + ethers.parseEther("2"));

    const refundRequestId = await system.chestRandomness.nextRequestId();
    const playerBefore = await system.matt.balanceOf(system.player.address);
    await (await system.chest.connect(system.player).openChest(SLOT.Armor)).wait();
    await networkHelpers.time.increase(24 * 60 * 60);
    await (await system.chest.connect(system.player).refundExpiredRequest(
      system.chestRandomness.target,
      refundRequestId
    )).wait();
    assert.equal(await system.matt.balanceOf(system.player.address), playerBefore);
    await assert.rejects(system.chestRandomness.fulfill(refundRequestId, 1n));

    await (await system.chest.pause()).wait();
    await expectCustomError(
      system.chest.configureDefinitionPool(1, SLOT.Pickaxe, RARITY.Common, [999999]),
      system.chest,
      "DefinitionVersionIsFrozen"
    );
  });

  it("atomically cancels a refunded VRF request and discards a late coordinator result", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const coordinator = await deploy("MockVRFCoordinatorV25");
    const adapter = await deploy("MattMineVRFV25Adapter", [
      coordinator.target,
      1n,
      ethers.id("v2-chest-vrf-key"),
      system.admin.address,
      3,
      1_400_000,
      1_000_000
    ]);
    await (await adapter.setConsumer(system.chest.target)).wait();
    await (await system.chest.pause()).wait();
    await (await system.chest.setRandomnessProvider(adapter.target)).wait();
    await (await system.chest.unpause()).wait();
    await (await system.matt.connect(system.player).approve(system.chest.target, ethers.parseEther("2"))).wait();

    const playerBefore = await system.matt.balanceOf(system.player.address);
    const nextEquipment = await system.equipment.nextTokenId();
    await (await system.chest.connect(system.player).openChest(SLOT.Pickaxe)).wait();
    assert.equal(await adapter.outstandingRequests(), 1n);
    await networkHelpers.time.increase(24 * 60 * 60);
    await (await system.chest.connect(system.player).refundExpiredRequest(adapter.target, 1n)).wait();
    assert.equal(await adapter.outstandingRequests(), 0n);
    assert.equal(await system.matt.balanceOf(system.player.address), playerBefore);

    await (await coordinator.fulfill(1n, 9_999n)).wait();
    const request = await adapter.requests(1n);
    assert.equal(request.fulfilled, true);
    assert.equal(request.delivered, false);
    assert.equal(request.cancelled, true);
    assert.equal(await system.equipment.nextTokenId(), nextEquipment);
  });

  it("enforces withdrawal minimum, wallet cap, global cap, and mint-only bank authority", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const runId = ethers.id("bank-test-run");
    await (await system.bank.credit(system.player.address, ethers.parseEther("200000"), runId)).wait();
    await expectCustomError(
      system.bank.connect(system.player).withdraw(ethers.parseEther("99")),
      system.bank,
      "WithdrawalTooSmall"
    );
    await (await system.bank.connect(system.player).withdraw(ethers.parseEther("100000"))).wait();
    assert.equal(await system.crystal.balanceOf(system.player.address), ethers.parseEther("100000"));
    await expectCustomError(
      system.bank.connect(system.player).withdraw(ethers.parseEther("100")),
      system.bank,
      "WalletDailyLimitExceeded"
    );
    await expectCustomError(
      system.bank.credit(system.player.address, 1n, runId),
      system.bank,
      "RunAlreadyCredited"
    );
  });

  it("assigns one permanent Level-100 rate and pays the exact midnight owner", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    await (await system.miner.applyXp(1n, 360_000n)).wait();
    const playBlock = await ethers.provider.getBlock("latest");
    const playedAt = BigInt(playBlock.timestamp);
    const activity = await system.miner.recordVerifiedPlay.staticCall(1n, playedAt);
    await (await system.miner.recordVerifiedPlay(1n, playedAt)).wait();
    await (await system.passive.recordActivity(1n, playedAt, activity[0], activity[1])).wait();
    const requestId = await system.passiveRandomness.nextRequestId();
    await (await system.passive.queueLevel100(1n)).wait();
    await (await system.passiveRandomness.fulfill(requestId, 9_999)).wait();
    const traits = await system.miner.traitsOf(1n);
    assert.equal(traits.crystalsPerHour, 50n);
    assert.equal(traits.earningStatus, 1n);

    const nextBoundary = Math.floor(Number(traits.cphAssignedAt) / 86_400 + 1) * 86_400;
    await networkHelpers.time.increaseTo(nextBoundary);
    await (await system.passive.connect(system.keeper).processPayouts(
      BigInt(nextBoundary / 86_400),
      [1n]
    )).wait();
    const expectedSeconds = BigInt(nextBoundary) - traits.cphAssignedAt;
    const expected = 50n * expectedSeconds * ethers.parseEther("1") / 3_600n;
    assert.equal(await system.crystal.balanceOf(system.player.address), expected);
    await (await system.passive.connect(system.keeper).processPayouts(
      BigInt(nextBoundary / 86_400),
      [1n]
    )).wait();
    assert.equal(await system.crystal.balanceOf(system.player.address), expected);
    await networkHelpers.time.increaseTo(traits.activeUntil);
    assert.equal(await system.miner.earningStatusOf(1n), 2n);
  });

  it("prorates every activity interval that overlaps the same UTC payout day", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    const latest = await ethers.provider.getBlock("latest");
    const boundary = BigInt(Math.floor(latest.timestamp / 86_400) * 86_400);
    const periodStart = boundary - 86_400n;
    const firstEnd = periodStart + 6n * 60n * 60n;
    const firstStart = firstEnd - 7n * 24n * 60n * 60n;
    const secondStart = firstEnd + 1n;
    const secondEnd = secondStart + 7n * 24n * 60n * 60n;

    await (await system.passive.recordActivity(1n, firstStart, 0n, firstEnd)).wait();
    await (await system.passive.recordActivity(1n, secondStart, firstEnd, secondEnd)).wait();

    assert.equal(
      await system.passive.eligibleSeconds(1n, periodStart, boundary),
      86_399n
    );
  });

  it("pays a transferred Miner to its boundary owner and delays public catch-up for one hour", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    await (await system.miner.applyXp(1n, 360_000n)).wait();
    const current = await ethers.provider.getBlock("latest");
    const playedAt = BigInt(current.timestamp);
    const activity = await system.miner.recordVerifiedPlay.staticCall(1n, playedAt);
    await (await system.miner.recordVerifiedPlay(1n, playedAt)).wait();
    await (await system.passive.recordActivity(1n, playedAt, activity[0], activity[1])).wait();
    const requestId = await system.passiveRandomness.nextRequestId();
    await (await system.passive.queueLevel100(1n)).wait();
    await (await system.passiveRandomness.fulfill(requestId, 9_999)).wait();
    const assigned = (await system.miner.traitsOf(1n)).cphAssignedAt;
    const boundary = Math.floor(Number(assigned) / 86_400 + 1) * 86_400;
    await (await system.miner.connect(system.player).transferFrom(
      system.player.address,
      system.buyer.address,
      1n
    )).wait();
    await networkHelpers.time.increaseTo(boundary);
    await expectCustomError(
      system.passive.connect(system.outsider).processPayouts(BigInt(boundary / 86_400), [1n]),
      system.passive,
      "PayoutTooEarly"
    );
    await (await system.passive.connect(system.keeper).processPayouts(
      BigInt(boundary / 86_400),
      [1n]
    )).wait();
    assert.equal(await system.crystal.balanceOf(system.player.address), 0n);
    assert.ok((await system.crystal.balanceOf(system.buyer.address)) > 0n);
  });

  it("blocks shared signer/operator activation and permits direct Root-admin upgrades", async function () {
    const system = await networkHelpers.loadFixture(deploySystem);
    await (await system.settlement.pause()).wait();
    await (await system.settlement.grantRole(OPERATOR_ROLE, system.rewardSigner.address)).wait();
    await expectCustomError(system.settlement.unpause(), system.settlement, "UnsafeRoleOverlap");
    await (await system.settlement.revokeRole(OPERATOR_ROLE, system.rewardSigner.address)).wait();
    await (await system.settlement.unpause()).wait();

    await expectCustomError(
      system.bank.connect(system.outsider).upgradeToAndCall(system.bankImplementation.target, "0x"),
      system.bank,
      "UnauthorizedUpgrade"
    );
    const directImplementation = await deploy("MattV2CrystalBank", [system.timelock.target]);
    await (await system.bank.upgradeToAndCall(directImplementation.target, "0x")).wait();
    assert.equal(await system.bank.tokenUnit(), ethers.parseEther("1"));
    const salt = ethers.id("bank-v2-upgrade-test");
    const operation = [system.bank.target, system.bankImplementation.target, "0x", salt];
    await (await system.timelock.schedule(...operation)).wait();
    await expectCustomError(
      system.timelock.execute(...operation),
      system.timelock,
      "UpgradeNotReady"
    );
    await networkHelpers.time.increase(48 * 60 * 60);
    await (await system.timelock.execute(...operation)).wait();
    assert.equal(await system.bank.tokenUnit(), ethers.parseEther("1"));

    const pinnedImplementation = await deploy("MattV2CrystalBank", [system.timelock.target]);
    const pinnedSalt = ethers.id("pinned-implementation-code");
    const pinnedOperation = [system.bank.target, pinnedImplementation.target, "0x", pinnedSalt];
    const pinnedOperationId = await system.timelock.operationId(...pinnedOperation);
    await (await system.timelock.schedule(...pinnedOperation)).wait();
    await networkHelpers.setCode(pinnedImplementation.target, "0x60006000fd");
    await expectCustomError(
      system.timelock.execute(...pinnedOperation),
      system.timelock,
      "OperationNotScheduled"
    );
    await (await system.timelock.cancel(pinnedOperationId)).wait();

    const foreignTimelock = await deploy("MattV2UpgradeTimelock", [system.admin.address]);
    const wrongImplementation = await deploy("MattV2CrystalBank", [foreignTimelock.target]);
    await expectCustomError(
      system.timelock.schedule(system.bank.target, wrongImplementation.target, "0x", ethers.id("wrong-timelock")),
      system.timelock,
      "ImplementationTimelockMismatch"
    );
  });
});
