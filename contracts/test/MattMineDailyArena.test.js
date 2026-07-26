import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const DAY = 24n * 60n * 60n;
const ENTRY_CUTOFF = 25n * 60n;
const MIN_FEE = ethers.parseEther("25000");
const MAX_FEE = ethers.parseEther("1000000");
const MAX_SEED = ethers.parseEther("10000000");
const LARGE_BALANCE = ethers.parseEther("100000000");

async function expectRevert(promise, expectedText) {
  try {
    await promise;
    assert.fail("Expected transaction to revert");
  } catch (error) {
    if (error.code === "ERR_ASSERTION") {
      throw error;
    }
    if (expectedText) {
      const rendered = String(error.shortMessage || error.message);
      const selector = ethers.id(`${expectedText}()`).slice(0, 10);
      if (!new RegExp(expectedText, "i").test(rendered)) {
        assert.ok(
          rendered.toLowerCase().includes(selector.toLowerCase()),
          `Expected revert ${expectedText}; received: ${rendered}`
        );
      }
    }
  }
}

function eventsNamed(contract, receipt, eventName) {
  const events = [];
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) {
        events.push(parsed);
      }
    } catch {
      // Ignore logs emitted by the MATT token.
    }
  }
  return events;
}

async function deployArena({ openEntries = true } = {}) {
  const signers = await ethers.getSigners();
  const [
    treasury,
    settler,
    pricer,
    pauser,
    alice,
    bob,
    carol,
    ...others
  ] = signers;

  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const matt = await tokenFactory.deploy("Matt", "MATT");
  await matt.waitForDeployment();

  const arenaFactory = await ethers.getContractFactory("MattMineDailyArena");
  const arena = await arenaFactory.deploy(
    matt.target,
    treasury.address,
    settler.address,
    pricer.address,
    pauser.address
  );
  await arena.waitForDeployment();
  if (openEntries) {
    await (await arena.connect(pauser).unpauseEntries()).wait();
  }

  for (const signer of [treasury, alice, bob, carol, ...others]) {
    await (await matt.mint(signer.address, LARGE_BALANCE)).wait();
  }

  return {
    signers,
    treasury,
    settler,
    pricer,
    pauser,
    alice,
    bob,
    carol,
    others,
    matt,
    arena
  };
}

async function approve(arena, matt, signer, amount = ethers.MaxUint256) {
  await (await matt.connect(signer).approve(arena.target, amount)).wait();
}

async function closeDay(arena, dayId) {
  await networkHelpers.time.increaseTo(await arena.dayEnd(dayId));
}

async function scheduleAndOpenNextDay(
  arena,
  pricer,
  entryFee = MIN_FEE
) {
  const dayId = (await arena.currentDayId()) + 1n;
  await (await arena.connect(pricer).scheduleDay(dayId, entryFee)).wait();
  await networkHelpers.time.increaseTo(dayId * DAY);
  return dayId;
}

describe("MattMineDailyArena", function () {
  it("wires immutable MATT and least-privilege roles to the supplied operators", async function () {
    const system = await deployArena({ openEntries: false });
    const {
      treasury,
      settler,
      pricer,
      pauser,
      alice,
      matt,
      arena
    } = system;

    assert.equal(await arena.matt(), matt.target);
    assert.equal(await arena.seedTreasury(), treasury.address);
    assert.equal(
      await arena.hasRole(await arena.DEFAULT_ADMIN_ROLE(), treasury.address),
      true
    );
    assert.equal(
      await arena.hasRole(await arena.TREASURY_ROLE(), treasury.address),
      true
    );
    assert.equal(
      await arena.hasRole(await arena.SETTLER_ROLE(), settler.address),
      true
    );
    assert.equal(
      await arena.hasRole(await arena.PRICER_ROLE(), pricer.address),
      true
    );
    assert.equal(
      await arena.hasRole(await arena.PAUSER_ROLE(), pauser.address),
      true
    );
    assert.equal(await arena.entriesPaused(), true);
    assert.equal(await arena.settlementPaused(), false);
    assert.equal(
      await arena.hasRole(await arena.PRICER_ROLE(), treasury.address),
      false
    );
    assert.equal(
      await arena.hasRole(await arena.SETTLER_ROLE(), treasury.address),
      false
    );

    const arenaFactory = await ethers.getContractFactory("MattMineDailyArena");
    const safeOperatedArena = await arenaFactory.deploy(
      matt.target,
      treasury.address,
      treasury.address,
      treasury.address,
      pauser.address
    );
    await safeOperatedArena.waitForDeployment();
    assert.equal(
      await safeOperatedArena.hasRole(
        await safeOperatedArena.DEFAULT_ADMIN_ROLE(),
        treasury.address
      ),
      true
    );
    assert.equal(
      await safeOperatedArena.hasRole(
        await safeOperatedArena.TREASURY_ROLE(),
        treasury.address
      ),
      true
    );
    assert.equal(
      await safeOperatedArena.hasRole(
        await safeOperatedArena.SETTLER_ROLE(),
        treasury.address
      ),
      true
    );
    assert.equal(
      await safeOperatedArena.hasRole(
        await safeOperatedArena.PRICER_ROLE(),
        treasury.address
      ),
      true
    );
    assert.equal(
      await safeOperatedArena.hasRole(
        await safeOperatedArena.PAUSER_ROLE(),
        pauser.address
      ),
      true
    );
    assert.equal(await safeOperatedArena.entriesPaused(), true);

    await expectRevert(
      arenaFactory.deploy(
        alice.address,
        treasury.address,
        settler.address,
        pricer.address,
        pauser.address
      ),
      "InvalidAddress"
    );
    await expectRevert(
      arenaFactory.deploy(
        matt.target,
        ethers.ZeroAddress,
        settler.address,
        pricer.address,
        pauser.address
      ),
      "InvalidAddress"
    );
  });

  it("schedules one immutable bounded fee only before a future UTC day begins", async function () {
    const { pricer, alice, arena } = await deployArena();
    const today = await arena.currentDayId();
    const scheduledDay = today + 1n;

    await expectRevert(
      arena.connect(alice).scheduleDay(scheduledDay, MIN_FEE),
      "AccessControl"
    );
    await expectRevert(
      arena.connect(pricer).scheduleDay(scheduledDay, MIN_FEE - 1n),
      "EntryFeeOutOfBounds"
    );
    await expectRevert(
      arena.connect(pricer).scheduleDay(scheduledDay, MAX_FEE + 1n),
      "EntryFeeOutOfBounds"
    );

    const scheduleReceipt = await (
      await arena.connect(pricer).scheduleDay(scheduledDay, MIN_FEE)
    ).wait();
    const scheduleEvents = eventsNamed(arena, scheduleReceipt, "DayScheduled");
    assert.equal(scheduleEvents.length, 1);
    assert.equal(scheduleEvents[0].args.dayId, scheduledDay);
    assert.equal(scheduleEvents[0].args.entryFeeMatt, MIN_FEE);

    const day = await arena.getDay(scheduledDay);
    assert.equal(day.status, 1n);
    assert.equal(day.entryFeeMatt, MIN_FEE);

    await expectRevert(
      arena.connect(pricer).scheduleDay(scheduledDay, MAX_FEE),
      "DayAlreadyScheduled"
    );
    await (await arena.connect(pricer).scheduleDay(today + 30n, MAX_FEE)).wait();
    assert.equal((await arena.getDay(today + 30n)).entryFeeMatt, MAX_FEE);

    await expectRevert(
      arena.connect(pricer).scheduleDay(today, MIN_FEE),
      "DayNotFuture"
    );
    await expectRevert(
      arena.connect(pricer).scheduleDay(today - 1n, MIN_FEE),
      "DayNotFuture"
    );
    await expectRevert(
      arena.dayEnd(ethers.MaxUint256),
      "InvalidDayId"
    );
  });

  it("rotates the seed Treasury only under a full pause with zero outstanding liabilities", async function () {
    const {
      treasury,
      settler,
      pricer,
      pauser,
      alice,
      bob,
      matt,
      arena
    } = await deployArena();
    const today = await scheduleAndOpenNextDay(arena, pricer);

    await expectRevert(
      arena.connect(treasury).setSeedTreasury(bob.address),
      "FullPauseRequired"
    );

    await approve(arena, matt, alice, MIN_FEE);
    await (await arena.connect(alice).enter(today)).wait();
    await (await arena.connect(pauser).pauseEntries()).wait();
    await (await arena.connect(pauser).pauseSettlement()).wait();

    await expectRevert(
      arena.connect(alice).setSeedTreasury(bob.address),
      "AccessControl"
    );
    await expectRevert(
      arena.connect(treasury).setSeedTreasury(bob.address),
      "ReservedMattOutstanding"
    );

    await (await arena.connect(pauser).unpauseSettlement()).wait();
    await (await arena.connect(settler).cancelDay(today)).wait();
    await (await arena.connect(alice).claimEntryRefund(today)).wait();
    assert.equal(await arena.totalReservedMatt(), 0n);
    await (await arena.connect(pauser).pauseSettlement()).wait();

    await expectRevert(
      arena.connect(treasury).setSeedTreasury(ethers.ZeroAddress),
      "InvalidAddress"
    );
    const rotationReceipt = await (
      await arena.connect(treasury).setSeedTreasury(bob.address)
    ).wait();
    const rotationEvent = eventsNamed(
      arena,
      rotationReceipt,
      "SeedTreasuryUpdated"
    )[0];
    assert.equal(rotationEvent.args.previousSeedTreasury, treasury.address);
    assert.equal(rotationEvent.args.newSeedTreasury, bob.address);
    assert.equal(await arena.seedTreasury(), bob.address);
    assert.equal(
      await arena.hasRole(await arena.TREASURY_ROLE(), treasury.address),
      false
    );
    assert.equal(
      await arena.hasRole(await arena.TREASURY_ROLE(), bob.address),
      true
    );
    await (await arena.connect(pauser).unpauseEntries()).wait();
    await (await arena.connect(pauser).unpauseSettlement()).wait();

    const tomorrow = today + 1n;
    const seed = ethers.parseEther("100000");
    await (await arena.connect(pricer).scheduleDay(tomorrow, MIN_FEE)).wait();
    await approve(arena, matt, bob, seed);
    await expectRevert(
      arena.connect(treasury).seedDay(tomorrow, seed),
      "AccessControl"
    );
    const bobBeforeSeed = await matt.balanceOf(bob.address);
    await (await arena.connect(bob).seedDay(tomorrow, seed)).wait();
    await (await arena.connect(settler).cancelDay(tomorrow)).wait();
    assert.equal(await matt.balanceOf(bob.address), bobBeforeSeed);
  });

  it("accepts unlimited same-wallet entries with exact payment, global unique numbers, and no pool ceiling", async function () {
    const { pricer, alice, matt, arena } = await deployArena();
    const today = await scheduleAndOpenNextDay(arena, pricer, MAX_FEE);
    const entryCount = 12n;
    const totalPaid = MAX_FEE * entryCount;

    await approve(arena, matt, alice, totalPaid);

    let firstReceipt;
    for (let index = 0n; index < entryCount; index += 1n) {
      const receipt = await (await arena.connect(alice).enter(today)).wait();
      if (index === 0n) {
        firstReceipt = receipt;
      }
    }

    const entryEvents = eventsNamed(
      arena,
      firstReceipt,
      "ContestEntered"
    );
    assert.equal(entryEvents.length, 1);
    assert.equal(entryEvents[0].args.entryNumber, 1n);
    assert.equal(entryEvents[0].args.wallet, alice.address);
    assert.equal(entryEvents[0].args.mattPaid, MAX_FEE);

    const day = await arena.getDay(today);
    assert.equal(day.entryCount, entryCount);
    assert.equal(day.entryMatt, totalPaid);
    assert.equal(day.seededMatt, 0n);
    assert.equal(day.reservedMatt, totalPaid);
    assert.ok(day.entryMatt > MAX_SEED);
    assert.equal(await arena.totalReservedMatt(), totalPaid);
    assert.equal(await matt.balanceOf(arena.target), totalPaid);
    assert.equal(await arena.nextEntryNumber(), entryCount + 1n);

    const walletDay = await arena.getWalletDay(today, alice.address);
    assert.equal(walletDay.entryCount, entryCount);
    assert.equal(walletDay.paidMatt, totalPaid);
    assert.equal(walletDay.refundedMatt, 0n);

    const firstEntry = await arena.getEntry(1);
    const lastEntry = await arena.getEntry(entryCount);
    assert.equal(firstEntry.dayId, today);
    assert.equal(firstEntry.wallet, alice.address);
    assert.equal(firstEntry.mattPaid, MAX_FEE);
    assert.equal(lastEntry.dayId, today);
    assert.equal(lastEntry.wallet, alice.address);
  });

  it("rejects unscheduled, wrong-day, and under-approved entries without changing accounting", async function () {
    const { pricer, alice, matt, arena } = await deployArena();
    const initialDay = await arena.currentDayId();
    const today = initialDay + 1n;
    const tomorrow = today + 1n;

    await expectRevert(
      arena.connect(alice).enter(initialDay),
      "DayNotScheduled"
    );
    await (await arena.connect(pricer).scheduleDay(today, MIN_FEE)).wait();
    await (await arena.connect(pricer).scheduleDay(tomorrow, MIN_FEE)).wait();
    await networkHelpers.time.increaseTo(today * DAY);

    await expectRevert(
      arena.connect(alice).enter(tomorrow),
      "DayNotCurrent"
    );
    await approve(arena, matt, alice, MIN_FEE - 1n);
    await expectRevert(
      arena.connect(alice).enter(today),
      "ERC20InsufficientAllowance"
    );

    assert.equal((await arena.getDay(today)).entryCount, 0n);
    assert.equal(await arena.totalReservedMatt(), 0n);
    assert.equal(await matt.balanceOf(arena.target), 0n);

    await approve(arena, matt, alice, MIN_FEE);
    const before = await matt.balanceOf(alice.address);
    await (await arena.connect(alice).enter(today)).wait();
    assert.equal(before - (await matt.balanceOf(alice.address)), MIN_FEE);
  });

  it("allows cumulative Treasury Safe seeding only up to 10,000,000 MATT before close", async function () {
    const { treasury, pricer, alice, matt, arena } = await deployArena();
    const today = await scheduleAndOpenNextDay(arena, pricer);
    const firstSeed = ethers.parseEther("4000000");
    const secondSeed = MAX_SEED - firstSeed;

    await approve(arena, matt, treasury, MAX_SEED + 1n);

    await expectRevert(
      arena.connect(alice).seedDay(today, 1n),
      "AccessControl"
    );
    await expectRevert(
      arena.connect(treasury).seedDay(today, 0n),
      "InvalidAmount"
    );

    await (await arena.connect(treasury).seedDay(today, firstSeed)).wait();
    const secondReceipt = await (
      await arena.connect(treasury).seedDay(today, secondSeed)
    ).wait();
    const seedEvents = eventsNamed(arena, secondReceipt, "DaySeeded");
    assert.equal(seedEvents.length, 1);
    assert.equal(seedEvents[0].args.totalSeededMatt, MAX_SEED);
    assert.equal(seedEvents[0].args.totalPoolMatt, MAX_SEED);

    const day = await arena.getDay(today);
    assert.equal(day.seededMatt, MAX_SEED);
    assert.equal(day.reservedMatt, MAX_SEED);
    assert.equal(await arena.totalReservedMatt(), MAX_SEED);

    await expectRevert(
      arena.connect(treasury).seedDay(today, 1n),
      "SeedLimitExceeded"
    );
    await closeDay(arena, today);
    await expectRevert(
      arena.connect(treasury).seedDay(today, 1n),
      "DayClosed"
    );
  });

  it("settles the entire closed pool to at most ten unique entrant wallets atomically", async function () {
    const system = await deployArena();
    const {
      treasury,
      settler,
      pricer,
      alice,
      matt,
      arena,
      signers
    } = system;
    const entrants = signers.slice(4, 15);
    const nonEntrant = signers[18];
    const today = await scheduleAndOpenNextDay(arena, pricer);
    const seed = ethers.parseEther("1000000");

    await approve(arena, matt, treasury, seed);
    await (await arena.connect(treasury).seedDay(today, seed)).wait();

    for (const entrant of entrants) {
      await approve(arena, matt, entrant, MIN_FEE);
      await (await arena.connect(entrant).enter(today)).wait();
    }

    const totalPool = seed + MIN_FEE * BigInt(entrants.length);
    await expectRevert(
      arena.connect(settler).settleDay(today, [alice.address], [totalPool]),
      "DayNotClosed"
    );

    await closeDay(arena, today);

    await expectRevert(
      arena.connect(alice).settleDay(today, [alice.address], [totalPool]),
      "AccessControl"
    );
    await expectRevert(
      arena.connect(settler).settleDay(
        today,
        entrants.map((entrant) => entrant.address),
        entrants.map(() => MIN_FEE)
      ),
      "TooManyWinners"
    );
    await expectRevert(
      arena.connect(settler).settleDay(
        today,
        [entrants[0].address],
        [MIN_FEE, totalPool - MIN_FEE]
      ),
      "WinnerListLengthMismatch"
    );
    await expectRevert(
      arena.connect(settler).settleDay(
        today,
        [entrants[0].address, entrants[0].address],
        [MIN_FEE, totalPool - MIN_FEE]
      ),
      "DuplicateWinner"
    );
    await expectRevert(
      arena.connect(settler).settleDay(
        today,
        [nonEntrant.address],
        [totalPool]
      ),
      "WinnerIsNotEntrant"
    );
    await expectRevert(
      arena.connect(settler).settleDay(today, [ethers.ZeroAddress], [totalPool]),
      "InvalidAddress"
    );
    await expectRevert(
      arena.connect(settler).settleDay(today, [entrants[0].address], [0n]),
      "InvalidAmount"
    );
    await expectRevert(
      arena.connect(settler).settleDay(
        today,
        [entrants[0].address],
        [totalPool - 1n]
      ),
      "PoolAllocationMismatch"
    );

    const winners = entrants.slice(0, 10);
    const amounts = winners.map((_, index) =>
      index < 9 ? MIN_FEE : totalPool - MIN_FEE * 9n
    );
    const beforeBalances = await Promise.all(
      winners.map((winner) => matt.balanceOf(winner.address))
    );
    const receipt = await (
      await arena.connect(settler).settleDay(
        today,
        winners.map((winner) => winner.address),
        amounts
      )
    ).wait();

    assert.equal(eventsNamed(arena, receipt, "PrizePaid").length, 10);
    assert.equal(eventsNamed(arena, receipt, "DaySettled").length, 1);
    for (let index = 0; index < winners.length; index += 1) {
      assert.equal(
        (await matt.balanceOf(winners[index].address)) - beforeBalances[index],
        amounts[index]
      );
    }

    const day = await arena.getDay(today);
    assert.equal(day.status, 2n);
    assert.equal(day.settledMatt, totalPool);
    assert.equal(day.reservedMatt, 0n);
    assert.equal(await arena.totalReservedMatt(), 0n);
    assert.equal(await matt.balanceOf(arena.target), 0n);

    const storedWinners = await arena.getWinners(today);
    assert.equal(storedWinners.length, 10);
    assert.equal(storedWinners[0].wallet, winners[0].address);
    assert.equal(storedWinners[9].mattAmount, amounts[9]);

    await expectRevert(
      arena.connect(settler).settleDay(today, [], []),
      "DayClosed"
    );
    await expectRevert(
      arena.connect(entrants[0]).claimEntryRefund(today),
      "DayNotCancelled"
    );
  });

  it("supports an empty settlement only for an empty closed pool", async function () {
    const { settler, pricer, arena } = await deployArena();
    const today = await scheduleAndOpenNextDay(arena, pricer);

    await closeDay(arena, today);
    await (await arena.connect(settler).settleDay(today, [], [])).wait();

    const day = await arena.getDay(today);
    assert.equal(day.status, 2n);
    assert.equal(day.settledMatt, 0n);
    assert.equal((await arena.getWinners(today)).length, 0);
  });

  it("cancels atomically, returns the seed, and aggregates every wallet's entry refunds", async function () {
    const {
      treasury,
      settler,
      pricer,
      pauser,
      alice,
      bob,
      carol,
      matt,
      arena
    } = await deployArena();
    const today = await scheduleAndOpenNextDay(arena, pricer);
    const seed = ethers.parseEther("3000000");
    const aliceEntries = 3n;
    const bobEntries = 2n;
    const entryPool = MIN_FEE * (aliceEntries + bobEntries);

    await approve(arena, matt, treasury, seed);
    await approve(arena, matt, alice, MIN_FEE * aliceEntries);
    await approve(arena, matt, bob, MIN_FEE * bobEntries);
    await (await arena.connect(treasury).seedDay(today, seed)).wait();
    for (let index = 0n; index < aliceEntries; index += 1n) {
      await (await arena.connect(alice).enter(today)).wait();
    }
    for (let index = 0n; index < bobEntries; index += 1n) {
      await (await arena.connect(bob).enter(today)).wait();
    }

    const treasuryBeforeCancel = await matt.balanceOf(treasury.address);
    const cancelReceipt = await (
      await arena.connect(settler).cancelDay(today)
    ).wait();
    assert.equal(
      (await matt.balanceOf(treasury.address)) - treasuryBeforeCancel,
      seed
    );
    const cancelEvent = eventsNamed(arena, cancelReceipt, "DayCancelled")[0];
    assert.equal(cancelEvent.args.refundableEntryMatt, entryPool);
    assert.equal(cancelEvent.args.seedReturnedMatt, seed);

    let day = await arena.getDay(today);
    assert.equal(day.status, 3n);
    assert.equal(day.reservedMatt, entryPool);
    assert.equal(await arena.totalReservedMatt(), entryPool);
    assert.equal(await matt.balanceOf(arena.target), entryPool);
    assert.equal(
      await arena.refundableMatt(today, alice.address),
      MIN_FEE * aliceEntries
    );
    assert.equal(
      await arena.refundableMatt(today, bob.address),
      MIN_FEE * bobEntries
    );

    await expectRevert(
      arena.connect(treasury).recoverExcess(1n),
      "ExcessMattUnavailable"
    );
    await expectRevert(
      arena.connect(settler).cancelDay(today),
      "DayClosed"
    );
    await expectRevert(
      arena.connect(settler).settleDay(today, [], []),
      "DayClosed"
    );
    await expectRevert(
      arena.connect(carol).claimEntryRefund(today),
      "NoEntryRefundAvailable"
    );

    await (await arena.connect(pauser).pauseEntries()).wait();
    await (await arena.connect(pauser).pauseSettlement()).wait();

    const aliceBefore = await matt.balanceOf(alice.address);
    const aliceRefundReceipt = await (
      await arena.connect(alice).claimEntryRefund(today)
    ).wait();
    assert.equal(
      (await matt.balanceOf(alice.address)) - aliceBefore,
      MIN_FEE * aliceEntries
    );
    const aliceRefundEvent = eventsNamed(
      arena,
      aliceRefundReceipt,
      "EntryRefundClaimed"
    )[0];
    assert.equal(aliceRefundEvent.args.entryCount, aliceEntries);
    assert.equal(aliceRefundEvent.args.mattAmount, MIN_FEE * aliceEntries);
    assert.equal(await arena.refundableMatt(today, alice.address), 0n);
    assert.equal(await arena.totalReservedMatt(), MIN_FEE * bobEntries);

    await expectRevert(
      arena.connect(alice).claimEntryRefund(today),
      "NoEntryRefundAvailable"
    );

    const cancelledDayExcess = ethers.parseEther("123");
    await (
      await matt.connect(carol).transfer(arena.target, cancelledDayExcess)
    ).wait();
    assert.equal(await arena.availableExcessMatt(), cancelledDayExcess);
    await (
      await arena.connect(treasury).recoverExcess(cancelledDayExcess)
    ).wait();
    assert.equal(await arena.availableExcessMatt(), 0n);
    assert.equal(await arena.totalReservedMatt(), MIN_FEE * bobEntries);
    assert.equal(await matt.balanceOf(arena.target), MIN_FEE * bobEntries);

    await (await arena.connect(bob).claimEntryRefund(today)).wait();

    day = await arena.getDay(today);
    assert.equal(day.refundedMatt, entryPool);
    assert.equal(day.reservedMatt, 0n);
    assert.equal(await arena.totalReservedMatt(), 0n);
    assert.equal(await matt.balanceOf(arena.target), 0n);
  });

  it("recovers only MATT above all live and cancelled-day reservations", async function () {
    const {
      treasury,
      pricer,
      alice,
      bob,
      matt,
      arena
    } = await deployArena();
    const today = await scheduleAndOpenNextDay(arena, pricer);
    const accidentalMatt = ethers.parseEther("123456");

    await approve(arena, matt, alice, MIN_FEE);
    await (await arena.connect(alice).enter(today)).wait();
    await (await matt.connect(bob).transfer(arena.target, accidentalMatt)).wait();

    assert.equal(await arena.totalReservedMatt(), MIN_FEE);
    assert.equal(await arena.availableExcessMatt(), accidentalMatt);

    await expectRevert(
      arena.connect(alice).recoverExcess(1n),
      "AccessControl"
    );
    await expectRevert(
      arena.connect(treasury).recoverExcess(0n),
      "InvalidAmount"
    );
    await expectRevert(
      arena.connect(treasury).recoverExcess(accidentalMatt + 1n),
      "ExcessMattUnavailable"
    );

    const treasuryBefore = await matt.balanceOf(treasury.address);
    await (
      await arena.connect(treasury).recoverExcess(accidentalMatt)
    ).wait();
    assert.equal(
      (await matt.balanceOf(treasury.address)) - treasuryBefore,
      accidentalMatt
    );
    assert.equal(await arena.availableExcessMatt(), 0n);
    assert.equal(await arena.totalReservedMatt(), MIN_FEE);
    assert.equal(await matt.balanceOf(arena.target), MIN_FEE);
  });

  it("conserves the global reserve ledger across live, cancelled, refunded, settled, and excess balances", async function () {
    const {
      treasury,
      settler,
      pricer,
      alice,
      bob,
      carol,
      others,
      matt,
      arena
    } = await deployArena();
    const initialDay = await arena.currentDayId();
    const today = initialDay + 1n;
    const tomorrow = today + 1n;
    const todaySeed = ethers.parseEther("100000");
    const tomorrowSeed = ethers.parseEther("200000");
    const accidentalMatt = ethers.parseEther("777");

    await (await arena.connect(pricer).scheduleDay(today, MIN_FEE)).wait();
    await (await arena.connect(pricer).scheduleDay(tomorrow, MIN_FEE)).wait();
    await networkHelpers.time.increaseTo(today * DAY);
    await approve(arena, matt, treasury, todaySeed + tomorrowSeed);
    await approve(arena, matt, alice, MIN_FEE * 2n);
    await approve(arena, matt, bob, MIN_FEE * 2n);
    await approve(arena, matt, carol, MIN_FEE);

    await (await arena.connect(treasury).seedDay(today, todaySeed)).wait();
    await (
      await arena.connect(treasury).seedDay(tomorrow, tomorrowSeed)
    ).wait();
    await (await arena.connect(alice).enter(today)).wait();
    await (await arena.connect(alice).enter(today)).wait();
    await (await arena.connect(bob).enter(today)).wait();

    assert.equal(
      await arena.totalReservedMatt(),
      todaySeed + tomorrowSeed + MIN_FEE * 3n
    );
    assert.equal(
      await matt.balanceOf(arena.target),
      await arena.totalReservedMatt()
    );

    await (await arena.connect(settler).cancelDay(today)).wait();
    await (await arena.connect(alice).claimEntryRefund(today)).wait();
    assert.equal((await arena.getDay(today)).reservedMatt, MIN_FEE);
    assert.equal(
      await arena.totalReservedMatt(),
      tomorrowSeed + MIN_FEE
    );

    await networkHelpers.time.increaseTo(tomorrow * DAY);
    await (await arena.connect(bob).enter(tomorrow)).wait();
    await (await arena.connect(carol).enter(tomorrow)).wait();

    const cancelledReserve = (await arena.getDay(today)).reservedMatt;
    const liveReserve = (await arena.getDay(tomorrow)).reservedMatt;
    assert.equal(cancelledReserve, MIN_FEE);
    assert.equal(liveReserve, tomorrowSeed + MIN_FEE * 2n);
    assert.equal(
      await arena.totalReservedMatt(),
      cancelledReserve + liveReserve
    );

    await (
      await matt.connect(others[0]).transfer(arena.target, accidentalMatt)
    ).wait();
    assert.equal(await arena.availableExcessMatt(), accidentalMatt);
    await (
      await arena.connect(treasury).recoverExcess(accidentalMatt)
    ).wait();
    assert.equal(await arena.availableExcessMatt(), 0n);
    assert.equal(
      await matt.balanceOf(arena.target),
      await arena.totalReservedMatt()
    );

    await closeDay(arena, tomorrow);
    const tomorrowPool = tomorrowSeed + MIN_FEE * 2n;
    await (
      await arena.connect(settler).settleDay(
        tomorrow,
        [bob.address, carol.address],
        [tomorrowPool - MIN_FEE, MIN_FEE]
      )
    ).wait();

    assert.equal((await arena.getDay(tomorrow)).reservedMatt, 0n);
    assert.equal(await arena.totalReservedMatt(), MIN_FEE);
    assert.equal(await matt.balanceOf(arena.target), MIN_FEE);
    assert.equal(await arena.availableExcessMatt(), 0n);

    await (await arena.connect(bob).claimEntryRefund(today)).wait();
    assert.equal((await arena.getDay(today)).reservedMatt, 0n);
    assert.equal(await arena.totalReservedMatt(), 0n);
    assert.equal(await matt.balanceOf(arena.target), 0n);
  });

  it("pauses entry and settlement independently while leaving safe funding and refunds available", async function () {
    const {
      treasury,
      settler,
      pricer,
      pauser,
      alice,
      bob,
      matt,
      arena
    } = await deployArena();
    const today = await scheduleAndOpenNextDay(arena, pricer);
    const seed = ethers.parseEther("100000");

    await approve(arena, matt, treasury, seed);
    await approve(arena, matt, alice, MIN_FEE * 2n);
    await approve(arena, matt, bob, MIN_FEE);
    await (await arena.connect(alice).enter(today)).wait();

    await expectRevert(
      arena.connect(alice).pauseEntries(),
      "AccessControl"
    );
    await (await arena.connect(pauser).pauseSettlement()).wait();
    await expectRevert(
      arena.connect(pauser).pauseSettlement(),
      "SettlementAlreadyPaused"
    );

    await (await arena.connect(alice).enter(today)).wait();
    await (await arena.connect(treasury).seedDay(today, seed)).wait();
    await expectRevert(
      arena.connect(settler).cancelDay(today),
      "SettlementOperationsPaused"
    );

    await (await arena.connect(pauser).pauseEntries()).wait();
    await expectRevert(
      arena.connect(pauser).pauseEntries(),
      "EntriesAlreadyPaused"
    );
    await expectRevert(
      arena.connect(bob).enter(today),
      "EntryOperationsPaused"
    );

    await (await arena.connect(pauser).unpauseSettlement()).wait();
    await closeDay(arena, today);
    const totalPool = seed + MIN_FEE * 2n;
    await (
      await arena.connect(settler).settleDay(
        today,
        [alice.address],
        [totalPool]
      )
    ).wait();
    assert.equal((await arena.getDay(today)).status, 2n);
    assert.equal(await arena.entriesPaused(), true);

    await (await arena.connect(pauser).unpauseEntries()).wait();
    await expectRevert(
      arena.connect(pauser).unpauseEntries(),
      "EntriesAlreadyUnpaused"
    );
    await expectRevert(
      arena.connect(pauser).unpauseSettlement(),
      "SettlementAlreadyUnpaused"
    );
  });

  it("uses exact UTC day boundaries and keeps entry numbers unique across days", async function () {
    const { settler, pricer, alice, matt, arena } = await deployArena();
    const latestBlock = await ethers.provider.getBlock("latest");
    const initialDay = BigInt(latestBlock.timestamp) / DAY;
    const today = initialDay + 1n;
    const tomorrow = today + 1n;

    assert.equal(await arena.currentDayId(), initialDay);
    assert.equal(await arena.dayEnd(today), tomorrow * DAY);
    assert.equal(await arena.entryCutoff(today), tomorrow * DAY - ENTRY_CUTOFF);

    await (await arena.connect(pricer).scheduleDay(today, MIN_FEE)).wait();
    await (await arena.connect(pricer).scheduleDay(tomorrow, MIN_FEE)).wait();
    await approve(arena, matt, alice, MIN_FEE * 2n);
    await networkHelpers.time.increaseTo(today * DAY);
    await (await arena.connect(alice).enter(today)).wait();

    await networkHelpers.time.increaseTo(tomorrow * DAY);
    assert.equal(await arena.currentDayId(), tomorrow);
    await expectRevert(
      arena.connect(alice).enter(today),
      "DayNotCurrent"
    );
    await (await arena.connect(alice).enter(tomorrow)).wait();

    const firstEntry = await arena.getEntry(1);
    const secondEntry = await arena.getEntry(2);
    assert.equal(firstEntry.dayId, today);
    assert.equal(secondEntry.dayId, tomorrow);
    assert.equal(firstEntry.wallet, alice.address);
    assert.equal(secondEntry.wallet, alice.address);
    assert.equal(await arena.totalReservedMatt(), MIN_FEE * 2n);

    await (
      await arena.connect(settler).settleDay(
        today,
        [alice.address],
        [MIN_FEE]
      )
    ).wait();
    assert.equal(await arena.totalReservedMatt(), MIN_FEE);
    assert.equal(await matt.balanceOf(arena.target), MIN_FEE);
    assert.equal((await arena.getDay(tomorrow)).reservedMatt, MIN_FEE);
    assert.equal(await arena.availableExcessMatt(), 0n);
    await expectRevert(
      arena.connect(pricer).scheduleDay(today, MIN_FEE),
      "DayNotFuture"
    );
  });

  it("rejects paid entries mined after the full-run cutoff without taking MATT", async function () {
    const { pricer, alice, matt, arena } = await deployArena();
    const dayId = await scheduleAndOpenNextDay(arena, pricer);
    await approve(arena, matt, alice, MIN_FEE * 2n);

    const cutoff = await arena.entryCutoff(dayId);
    // The next transaction mines one second later, exactly on the cutoff.
    await networkHelpers.time.increaseTo(cutoff - 1n);
    await (await arena.connect(alice).enter(dayId)).wait();

    const balanceAfterValidEntry = await matt.balanceOf(alice.address);
    await networkHelpers.time.increase(1);
    await expectRevert(
      arena.connect(alice).enter(dayId),
      "EntryWindowClosed"
    );
    assert.equal(await matt.balanceOf(alice.address), balanceAfterValidEntry);
    assert.equal((await arena.getDay(dayId)).entryCount, 1n);
  });

  it("rejects direct native-currency transfers", async function () {
    const { alice, arena } = await deployArena();
    await expectRevert(
      alice.sendTransaction({ to: arena.target, value: 1n }),
      "DirectPaymentDisabled"
    );
  });
});
