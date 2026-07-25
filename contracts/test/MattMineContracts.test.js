import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const DAY = 24 * 60 * 60;

async function expectRevert(promise, expectedText) {
  try {
    await promise;
    assert.fail("Expected transaction to revert");
  } catch (error) {
    if (error.code === "ERR_ASSERTION") {
      throw error;
    }
    if (expectedText) {
      assert.match(String(error.shortMessage || error.message), new RegExp(expectedText, "i"));
    }
  }
}

async function deployPass(signers, overrides = {}) {
  const [admin, priceManager, pauser, operations, rewards, growth] = signers;
  const initialPrice = overrides.initialPrice || ethers.parseEther("95");
  const minimumPrice = overrides.minimumPrice || ethers.parseEther("55");
  const maximumPrice = overrides.maximumPrice || ethers.parseEther("155");
  const factory = await ethers.getContractFactory("MattMinePass");
  const pass = await factory.deploy(
    admin.address,
    priceManager.address,
    pauser.address,
    operations.address,
    rewards.address,
    growth.address,
    initialPrice,
    minimumPrice,
    maximumPrice
  );
  await pass.waitForDeployment();
  return { pass, initialPrice, minimumPrice, maximumPrice };
}

async function deploySystem() {
  const signers = await ethers.getSigners();
  const [
    admin,
    priceManager,
    configManager,
    pauser,
    publisher,
    treasuryManager,
    operations,
    passRewards,
    growth,
    futureRewards,
    reserve,
    player,
    secondPlayer
  ] = signers;

  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const matt = await tokenFactory.deploy("Matt", "MATT");
  const wron = await tokenFactory.deploy("Wrapped Ronin", "WRON");
  await Promise.all([matt.waitForDeployment(), wron.waitForDeployment()]);

  const { pass } = await deployPass(
    [admin, priceManager, pauser, operations, passRewards, growth]
  );

  const routerFactory = await ethers.getContractFactory("MockKatanaRouter");
  const outputRate = 1_000n;
  const router = await routerFactory.deploy(wron.target, matt.target, outputRate);
  await router.waitForDeployment();

  const executorFactory = await ethers.getContractFactory("MattMineSwapExecutor");
  const executor = await executorFactory.deploy(
    admin.address,
    pauser.address,
    router.target,
    wron.target,
    matt.target
  );
  await executor.waitForDeployment();

  const rewardsFactory = await ethers.getContractFactory("MattMineRewards");
  const rewardContract = await rewardsFactory.deploy(
    matt.target,
    admin.address,
    publisher.address,
    treasuryManager.address,
    pauser.address,
    reserve.address
  );
  await rewardContract.waitForDeployment();

  const runsFactory = await ethers.getContractFactory("MattMineRuns");
  const paidRunPrice = ethers.parseEther("10");
  const runs = await runsFactory.deploy(
    pass.target,
    matt.target,
    executor.target,
    admin.address,
    priceManager.address,
    configManager.address,
    pauser.address,
    rewardContract.target,
    futureRewards.address,
    reserve.address,
    paidRunPrice,
    ethers.parseEther("5"),
    ethers.parseEther("20")
  );
  await runs.waitForDeployment();

  const runsRole = await executor.RUNS_ROLE();
  await (await executor.connect(admin).grantRole(runsRole, runs.target)).wait();

  return {
    signers,
    admin,
    priceManager,
    configManager,
    pauser,
    publisher,
    treasuryManager,
    operations,
    passRewards,
    growth,
    futureRewards,
    reserve,
    player,
    secondPlayer,
    matt,
    wron,
    pass,
    router,
    executor,
    rewardContract,
    runs,
    outputRate,
    paidRunPrice
  };
}

describe("MattMinePass", function () {
  it("activates and extends a 30-day pass while routing RON 50/30/20", async function () {
    const signers = await ethers.getSigners();
    const [admin, priceManager, pauser, operations, rewards, growth, player] = signers;
    const { pass, initialPrice } = await deployPass(
      [admin, priceManager, pauser, operations, rewards, growth]
    );

    const before = {
      operations: await ethers.provider.getBalance(operations.address),
      rewards: await ethers.provider.getBalance(rewards.address),
      growth: await ethers.provider.getBalance(growth.address)
    };

    await (await pass.connect(player).purchasePass({ value: initialPrice })).wait();
    const firstExpiry = await pass.passExpiresAt(player.address);
    assert.equal(await pass.hasActivePass(player.address), true);
    assert.equal(
      (await ethers.provider.getBalance(operations.address)) - before.operations,
      (initialPrice * 5_000n) / 10_000n
    );
    assert.equal(
      (await ethers.provider.getBalance(rewards.address)) - before.rewards,
      (initialPrice * 3_000n) / 10_000n
    );
    assert.equal(
      (await ethers.provider.getBalance(growth.address)) - before.growth,
      (initialPrice * 2_000n) / 10_000n
    );

    await (await pass.connect(player).purchasePass({ value: initialPrice })).wait();
    assert.equal(await pass.passExpiresAt(player.address), firstExpiry + 30n * BigInt(DAY));
    assert.equal(await ethers.provider.getBalance(pass.target), 0n);
  });

  it("enforces exact payment, bounded pricing, pause controls, and paused treasury changes", async function () {
    const signers = await ethers.getSigners();
    const [admin, priceManager, pauser, operations, rewards, growth, player, replacement] = signers;
    const { pass, initialPrice, maximumPrice } = await deployPass(
      [admin, priceManager, pauser, operations, rewards, growth]
    );

    await expectRevert(
      pass.connect(player).purchasePass({ value: initialPrice - 1n }),
      "IncorrectRonPayment"
    );
    await expectRevert(
      pass.connect(player).setPassPriceRon(ethers.parseEther("2")),
      "AccessControl"
    );
    await expectRevert(
      pass.connect(priceManager).setPassPriceRon(maximumPrice + 1n),
      "PriceOutOfBounds"
    );
    await expectRevert(
      pass.connect(admin).setRevenueRecipients(
        replacement.address,
        rewards.address,
        growth.address
      ),
      "ExpectedPause"
    );

    await (await pass.connect(pauser).pause()).wait();
    await expectRevert(
      pass.connect(player).purchasePass({ value: initialPrice }),
      "EnforcedPause"
    );
    await (await pass.connect(admin).setRevenueRecipients(
      replacement.address,
      rewards.address,
      growth.address
    )).wait();
    assert.equal(await pass.operationsTreasury(), replacement.address);
    await (await pass.connect(pauser).unpause()).wait();
  });

  it("limits pass and paid-run price changes to once every seven days", async function () {
    const system = await deploySystem();
    const { priceManager, pass, runs } = system;

    await (await pass.connect(priceManager).setPassPriceRon(
      ethers.parseEther("96")
    )).wait();
    await (await runs.connect(priceManager).setPaidRunPriceRon(
      ethers.parseEther("11")
    )).wait();

    await expectRevert(
      pass.connect(priceManager).setPassPriceRon(ethers.parseEther("97")),
      "PriceUpdateCooldownActive"
    );
    await expectRevert(
      runs.connect(priceManager).setPaidRunPriceRon(ethers.parseEther("12")),
      "PriceUpdateCooldownActive"
    );

    await networkHelpers.time.increase(7 * DAY);
    await (await pass.connect(priceManager).setPassPriceRon(
      ethers.parseEther("97")
    )).wait();
    await (await runs.connect(priceManager).setPaidRunPriceRon(
      ethers.parseEther("12")
    )).wait();

    assert.equal(await pass.passPriceRon(), ethers.parseEther("97"));
    assert.equal(await runs.paidRunPriceRon(), ethers.parseEther("12"));
  });
});

describe("MattMineSwapExecutor and MattMineRuns", function () {
  it("requires a pass, buys MATT, routes 70/20/10, and creates one entitlement", async function () {
    const system = await deploySystem();
    const {
      player,
      pass,
      runs,
      rewardContract,
      futureRewards,
      reserve,
      matt,
      paidRunPrice,
      outputRate
    } = system;
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 600);
    const expectedMatt = paidRunPrice * outputRate;

    await expectRevert(
      runs.connect(player).purchasePaidRun(expectedMatt, deadline, { value: paidRunPrice }),
      "ActivePassRequired"
    );

    await (await pass.connect(player).purchasePass({ value: await pass.passPriceRon() })).wait();
    await (await runs.connect(player).purchasePaidRun(
      expectedMatt,
      deadline,
      { value: paidRunPrice }
    )).wait();

    assert.equal(await runs.paidRunsToday(player.address), 1n);
    assert.equal(await runs.nextEntitlementId(), 2n);
    assert.equal(await matt.balanceOf(rewardContract.target), (expectedMatt * 7_000n) / 10_000n);
    assert.equal(await matt.balanceOf(futureRewards.address), (expectedMatt * 2_000n) / 10_000n);
    assert.equal(await matt.balanceOf(reserve.address), (expectedMatt * 1_000n) / 10_000n);
    assert.equal(await matt.balanceOf(runs.target), 0n);
  });

  it("enforces the ten-run UTC cap, exact price, deadlines, and emergency pause", async function () {
    const system = await deploySystem();
    const { player, pass, runs, pauser, paidRunPrice, outputRate } = system;
    await (await pass.connect(player).purchasePass({ value: await pass.passPriceRon() })).wait();

    await expectRevert(
      runs.connect(player).purchasePaidRun(1n, 0, { value: paidRunPrice }),
      "InvalidDeadline"
    );
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 600);
    await expectRevert(
      runs.connect(player).purchasePaidRun(1n, deadline, { value: paidRunPrice - 1n }),
      "IncorrectRonPayment"
    );

    for (let index = 0; index < 10; index += 1) {
      await (await runs.connect(player).purchasePaidRun(
        paidRunPrice * outputRate,
        deadline,
        { value: paidRunPrice }
      )).wait();
    }
    await expectRevert(
      runs.connect(player).purchasePaidRun(
        paidRunPrice * outputRate,
        deadline,
        { value: paidRunPrice }
      ),
      "DailyRunLimitReached"
    );

    await (await runs.connect(pauser).pause()).wait();
    await networkHelpers.time.increase(DAY);
    const nextDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 600);
    await expectRevert(
      runs.connect(player).purchasePaidRun(1n, nextDeadline, { value: paidRunPrice }),
      "EnforcedPause"
    );
  });

  it("allows executor and destination changes only through the configured role while paused", async function () {
    const system = await deploySystem();
    const { player, configManager, pauser, runs, executor, futureRewards, reserve } = system;

    await expectRevert(
      runs.connect(player).setSwapExecutor(executor.target),
      "AccessControl"
    );
    await expectRevert(
      runs.connect(configManager).setRewardDestinations(
        player.address,
        futureRewards.address,
        reserve.address
      ),
      "ExpectedPause"
    );
    await (await runs.connect(pauser).pause()).wait();
    await (await runs.connect(configManager).setRewardDestinations(
      player.address,
      futureRewards.address,
      reserve.address
    )).wait();
    assert.equal(await runs.currentRewardsVault(), player.address);
  });

  it("blocks direct executor use and rejects stale or under-protected swaps", async function () {
    const system = await deploySystem();
    const { admin, player, executor, paidRunPrice, outputRate } = system;
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 600);

    await expectRevert(
      executor.connect(player).swapRonForMatt(1n, deadline, { value: paidRunPrice }),
      "AccessControl"
    );

    await (await executor.connect(admin).grantRole(await executor.RUNS_ROLE(), player.address)).wait();
    await expectRevert(
      executor.connect(player).swapRonForMatt(
        paidRunPrice * outputRate + 1n,
        deadline,
        { value: paidRunPrice }
      ),
      "MinimumOutputNotMet"
    );
    await expectRevert(
      executor.connect(player).swapRonForMatt(1n, deadline + 10_000n, { value: paidRunPrice }),
      "InvalidDeadline"
    );
  });

  it("hands executor administration to the final multisig and removes the bootstrap deployer", async function () {
    const system = await deploySystem();
    const {
      admin: bootstrapAdmin,
      secondPlayer: finalAdmin,
      player,
      executor
    } = system;
    const defaultAdminRole = await executor.DEFAULT_ADMIN_ROLE();

    await (await executor.connect(bootstrapAdmin).grantRole(
      defaultAdminRole,
      finalAdmin.address
    )).wait();
    await (await executor.connect(bootstrapAdmin).renounceRole(
      defaultAdminRole,
      bootstrapAdmin.address
    )).wait();

    assert.equal(
      await executor.hasRole(defaultAdminRole, finalAdmin.address),
      true
    );
    assert.equal(
      await executor.hasRole(defaultAdminRole, bootstrapAdmin.address),
      false
    );
    await expectRevert(
      executor.connect(bootstrapAdmin).grantRole(
        await executor.RUNS_ROLE(),
        player.address
      ),
      "AccessControl"
    );
  });
});

describe("MattMineRewards", function () {
  async function fundedRewardsFixture() {
    const system = await deploySystem();
    const { matt, treasuryManager, rewardContract } = system;
    const funding = ethers.parseEther("1000000");
    await (await matt.mint(treasuryManager.address, funding)).wait();
    await (await matt.connect(treasuryManager).approve(rewardContract.target, funding)).wait();
    await (await rewardContract.connect(treasuryManager).fundRewards(funding)).wait();
    return { ...system, funding };
  }

  function rewardTree(chainId, contractAddress, epoch, board, entries) {
    return StandardMerkleTree.of(
      entries.map(({ player, amount }) => [
        chainId.toString(),
        contractAddress,
        epoch.toString(),
        board.toString(),
        player,
        amount.toString()
      ]),
      ["uint256", "address", "uint256", "uint8", "address", "uint256"]
    );
  }

  function proofFor(tree, player) {
    for (const [index, value] of tree.entries()) {
      if (value[4].toLowerCase() === player.toLowerCase()) {
        return tree.getProof(index);
      }
    }
    throw new Error("Player not present in tree");
  }

  it("publishes immutable Free and Pass epochs and pays one valid claim per wallet", async function () {
    const system = await fundedRewardsFixture();
    const {
      player,
      secondPlayer,
      publisher,
      rewardContract,
      matt
    } = system;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const epoch = 7;
    const board = 0;
    const playerAmount = ethers.parseEther("250000");
    const secondAmount = ethers.parseEther("150000");
    const tree = rewardTree(chainId, rewardContract.target, epoch, board, [
      { player: player.address, amount: playerAmount },
      { player: secondPlayer.address, amount: secondAmount }
    ]);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 7 * DAY;

    await (await rewardContract.connect(publisher).publishRewardEpoch(
      epoch,
      board,
      tree.root,
      playerAmount + secondAmount,
      deadline
    )).wait();

    await expectRevert(
      rewardContract.connect(publisher).publishRewardEpoch(
        epoch,
        board,
        tree.root,
        playerAmount + secondAmount,
        deadline
      ),
      "EpochAlreadyPublished"
    );

    await (await rewardContract.connect(player).claim(
      epoch,
      board,
      playerAmount,
      proofFor(tree, player.address)
    )).wait();
    assert.equal(await matt.balanceOf(player.address), playerAmount);
    assert.equal(await rewardContract.isClaimed(epoch, board, player.address), true);
    await expectRevert(
      rewardContract.connect(player).claim(
        epoch,
        board,
        playerAmount,
        proofFor(tree, player.address)
      ),
      "DuplicateClaim"
    );
    await expectRevert(
      rewardContract.connect(secondPlayer).claim(
        epoch,
        board,
        secondAmount,
        proofFor(tree, player.address)
      ),
      "InvalidMerkleProof"
    );
  });

  it("protects active allocations and returns only expired or unallocated MATT", async function () {
    const system = await fundedRewardsFixture();
    const {
      player,
      publisher,
      treasuryManager,
      reserve,
      rewardContract,
      matt,
      funding
    } = system;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const epoch = 8;
    const board = 1;
    const allocation = ethers.parseEther("800000");
    const tree = rewardTree(chainId, rewardContract.target, epoch, board, [
      { player: player.address, amount: allocation }
    ]);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 7 * DAY;
    await (await rewardContract.connect(publisher).publishRewardEpoch(
      epoch,
      board,
      tree.root,
      allocation,
      deadline
    )).wait();

    await expectRevert(
      rewardContract.connect(treasuryManager).recoverExpiredRewards(epoch, board),
      "ClaimNotExpired"
    );
    await expectRevert(
      rewardContract.connect(treasuryManager).recoverUnallocatedRewards(
        funding - allocation + 1n
      ),
      "ActiveRewardFundsReserved"
    );
    await (await rewardContract.connect(treasuryManager).recoverUnallocatedRewards(
      funding - allocation
    )).wait();

    await networkHelpers.time.increase(8 * DAY);
    await (await rewardContract.connect(treasuryManager).recoverExpiredRewards(
      epoch,
      board
    )).wait();

    assert.equal(await matt.balanceOf(reserve.address), funding);
    assert.equal(await rewardContract.totalReservedMatt(), 0n);
    assert.equal((await rewardContract.getEpoch(epoch, board)).closed, true);
  });

  it("rejects a valid Merkle leaf that exceeds the published epoch allocation", async function () {
    const system = await fundedRewardsFixture();
    const { player, publisher, rewardContract } = system;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const epoch = 9;
    const board = 0;
    const publishedTotal = ethers.parseEther("100");
    const oversizedClaim = ethers.parseEther("101");
    const tree = rewardTree(chainId, rewardContract.target, epoch, board, [
      { player: player.address, amount: oversizedClaim }
    ]);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + DAY;

    await (await rewardContract.connect(publisher).publishRewardEpoch(
      epoch,
      board,
      tree.root,
      publishedTotal,
      deadline
    )).wait();
    await expectRevert(
      rewardContract.connect(player).claim(
        epoch,
        board,
        oversizedClaim,
        proofFor(tree, player.address)
      ),
      "RewardAllocationExceeded"
    );
  });

  it("uses separate publisher, treasury, pauser, and admin permissions", async function () {
    const system = await fundedRewardsFixture();
    const {
      player,
      pauser,
      rewardContract
    } = system;
    await expectRevert(
      rewardContract.connect(player).publishRewardEpoch(
        1,
        0,
        ethers.keccak256(ethers.toUtf8Bytes("root")),
        1n,
        (await ethers.provider.getBlock("latest")).timestamp + DAY
      ),
      "AccessControl"
    );
    await (await rewardContract.connect(pauser).pause()).wait();
    await expectRevert(
      rewardContract.connect(player).claim(1, 0, 1n, []),
      "EnforcedPause"
    );
  });
});
