// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMattMineDailyArena} from "../interfaces/IMattMineDailyArena.sol";

contract MattMineDailyArena is IMattMineDailyArena, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant DAY_DURATION = 1 days;
    uint256 public constant ENTRY_CUTOFF_DURATION = 25 minutes;
    uint256 public constant MIN_ENTRY_FEE_MATT = 25_000e18;
    uint256 public constant MAX_ENTRY_FEE_MATT = 1_000_000e18;
    uint256 public constant MAX_DAILY_SEED_MATT = 10_000_000e18;
    uint256 public constant MAX_WINNERS = 10;

    IERC20 public immutable override matt;
    address public override seedTreasury;

    uint256 public override nextEntryNumber = 1;
    uint256 public override totalReservedMatt;
    bool public override entriesPaused;
    bool public override settlementPaused;

    mapping(uint256 dayId => Day day) private _days;
    mapping(uint256 dayId => mapping(address wallet => WalletDay walletDay))
        private _walletDays;
    mapping(uint256 entryNumber => Entry entryData) private _entries;
    mapping(uint256 dayId => Winner[] winners) private _winners;

    error DayAlreadyScheduled(uint256 dayId);
    error DayClosed(uint256 dayId);
    error DayNotFuture(uint256 dayId, uint256 currentDay);
    error DayNotClosed(uint256 dayId, uint256 closesAt);
    error DayNotCurrent(uint256 expectedDayId, uint256 currentDay);
    error DayNotScheduled(uint256 dayId);
    error DuplicateWinner(address wallet);
    error EntriesAlreadyPaused();
    error EntriesAlreadyUnpaused();
    error EntryWindowClosed(uint256 dayId, uint256 cutoff);
    error EntryFeeOutOfBounds(uint256 entryFeeMatt);
    error EntryOperationsPaused();
    error ExcessMattUnavailable(uint256 availableMatt, uint256 requestedMatt);
    error FullPauseRequired();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDayId(uint256 dayId);
    error NoEntryRefundAvailable();
    error DayNotCancelled(uint256 dayId);
    error PoolAllocationMismatch(uint256 totalPoolMatt, uint256 allocatedMatt);
    error SeedLimitExceeded(uint256 maximumSeedMatt, uint256 requestedTotalSeedMatt);
    error ReservedMattOutstanding(uint256 reservedMatt);
    error SettlementAlreadyPaused();
    error SettlementAlreadyUnpaused();
    error SettlementOperationsPaused();
    error TokenAccountingMismatch(uint256 expectedMatt, uint256 receivedMatt);
    error TooManyWinners(uint256 maximumWinners, uint256 suppliedWinners);
    error WinnerIsNotEntrant(address wallet);
    error WinnerListLengthMismatch(uint256 walletCount, uint256 amountCount);
    error DirectPaymentDisabled();

    constructor(
        address mattAddress,
        address treasurySafe,
        address settler,
        address pricer,
        address emergencyPauser
    ) {
        if (
            mattAddress == address(0) || treasurySafe == address(0)
                || settler == address(0) || pricer == address(0)
                || emergencyPauser == address(0) || mattAddress.code.length == 0
        ) {
            revert InvalidAddress();
        }

        matt = IERC20(mattAddress);
        seedTreasury = treasurySafe;

        _grantRole(DEFAULT_ADMIN_ROLE, treasurySafe);
        _grantRole(TREASURY_ROLE, treasurySafe);
        _grantRole(SETTLER_ROLE, settler);
        _grantRole(PRICER_ROLE, pricer);
        _grantRole(PAUSER_ROLE, emergencyPauser);

        // A deployment must never accept player MATT merely because the
        // contract address becomes public. The independent emergency pauser
        // explicitly opens entries only after the reviewed game server is
        // release-ready.
        entriesPaused = true;
    }

    modifier whenEntriesNotPaused() {
        if (entriesPaused) {
            revert EntryOperationsPaused();
        }
        _;
    }

    modifier whenSettlementNotPaused() {
        if (settlementPaused) {
            revert SettlementOperationsPaused();
        }
        _;
    }

    function currentDayId() public view override returns (uint256) {
        return block.timestamp / DAY_DURATION;
    }

    function dayEnd(uint256 dayId) public pure override returns (uint256) {
        if (dayId >= type(uint256).max / DAY_DURATION) {
            revert InvalidDayId(dayId);
        }
        return (dayId + 1) * DAY_DURATION;
    }

    function entryCutoff(uint256 dayId)
        public
        pure
        override
        returns (uint256)
    {
        return dayEnd(dayId) - ENTRY_CUTOFF_DURATION;
    }

    function scheduleDay(uint256 dayId, uint256 entryFeeMatt)
        external
        override
        onlyRole(PRICER_ROLE)
    {
        uint256 today = currentDayId();
        if (dayId <= today) {
            revert DayNotFuture(dayId, today);
        }
        if (dayId >= type(uint256).max / DAY_DURATION) {
            revert InvalidDayId(dayId);
        }
        if (
            entryFeeMatt < MIN_ENTRY_FEE_MATT
                || entryFeeMatt > MAX_ENTRY_FEE_MATT
        ) {
            revert EntryFeeOutOfBounds(entryFeeMatt);
        }

        Day storage day = _days[dayId];
        if (day.status != DayStatus.Unscheduled) {
            revert DayAlreadyScheduled(dayId);
        }

        day.status = DayStatus.Scheduled;
        day.entryFeeMatt = entryFeeMatt;

        emit DayScheduled(dayId, entryFeeMatt);
    }

    function seedDay(uint256 dayId, uint256 mattAmount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
    {
        if (mattAmount == 0) {
            revert InvalidAmount();
        }

        Day storage day = _scheduledDay(dayId);
        if (block.timestamp >= dayEnd(dayId)) {
            revert DayClosed(dayId);
        }

        uint256 newSeededMatt = day.seededMatt + mattAmount;
        if (newSeededMatt > MAX_DAILY_SEED_MATT) {
            revert SeedLimitExceeded(MAX_DAILY_SEED_MATT, newSeededMatt);
        }

        _pullExact(seedTreasury, mattAmount);

        day.seededMatt = newSeededMatt;
        day.reservedMatt += mattAmount;
        totalReservedMatt += mattAmount;

        emit DaySeeded(
            dayId,
            seedTreasury,
            mattAmount,
            newSeededMatt,
            day.entryMatt + newSeededMatt
        );
    }

    function enter(uint256 dayId)
        external
        override
        nonReentrant
        whenEntriesNotPaused
        returns (uint256 entryNumber)
    {
        uint256 today = currentDayId();
        if (dayId != today) {
            revert DayNotCurrent(dayId, today);
        }

        Day storage day = _scheduledDay(dayId);
        uint256 cutoff = entryCutoff(dayId);
        if (block.timestamp > cutoff) {
            revert EntryWindowClosed(dayId, cutoff);
        }
        uint256 entryFeeMatt = day.entryFeeMatt;

        _pullExact(msg.sender, entryFeeMatt);

        entryNumber = nextEntryNumber++;
        _entries[entryNumber] = Entry({
            dayId: dayId,
            wallet: msg.sender,
            mattPaid: entryFeeMatt
        });

        day.entryCount += 1;
        day.entryMatt += entryFeeMatt;
        day.reservedMatt += entryFeeMatt;
        totalReservedMatt += entryFeeMatt;

        WalletDay storage walletDay = _walletDays[dayId][msg.sender];
        walletDay.entryCount += 1;
        walletDay.paidMatt += entryFeeMatt;

        emit ContestEntered(
            dayId,
            entryNumber,
            msg.sender,
            entryFeeMatt,
            day.entryMatt + day.seededMatt
        );
    }

    function settleDay(
        uint256 dayId,
        address[] calldata winners,
        uint256[] calldata amounts
    )
        external
        override
        onlyRole(SETTLER_ROLE)
        nonReentrant
        whenSettlementNotPaused
    {
        Day storage day = _scheduledDay(dayId);
        uint256 closesAt = dayEnd(dayId);
        if (block.timestamp < closesAt) {
            revert DayNotClosed(dayId, closesAt);
        }

        uint256 winnerCount = winners.length;
        if (winnerCount != amounts.length) {
            revert WinnerListLengthMismatch(winnerCount, amounts.length);
        }
        if (winnerCount > MAX_WINNERS) {
            revert TooManyWinners(MAX_WINNERS, winnerCount);
        }

        uint256 allocatedMatt;
        for (uint256 index = 0; index < winnerCount; ++index) {
            address wallet = winners[index];
            uint256 mattAmount = amounts[index];
            if (wallet == address(0)) {
                revert InvalidAddress();
            }
            if (mattAmount == 0) {
                revert InvalidAmount();
            }
            if (_walletDays[dayId][wallet].entryCount == 0) {
                revert WinnerIsNotEntrant(wallet);
            }
            for (uint256 priorIndex = 0; priorIndex < index; ++priorIndex) {
                if (winners[priorIndex] == wallet) {
                    revert DuplicateWinner(wallet);
                }
            }
            allocatedMatt += mattAmount;
        }

        uint256 totalPoolMatt = day.entryMatt + day.seededMatt;
        if (allocatedMatt != totalPoolMatt) {
            revert PoolAllocationMismatch(totalPoolMatt, allocatedMatt);
        }

        day.status = DayStatus.Settled;
        day.reservedMatt = 0;
        day.settledMatt = totalPoolMatt;
        totalReservedMatt -= totalPoolMatt;

        for (uint256 index = 0; index < winnerCount; ++index) {
            address wallet = winners[index];
            uint256 mattAmount = amounts[index];
            _winners[dayId].push(Winner({wallet: wallet, mattAmount: mattAmount}));
            matt.safeTransfer(wallet, mattAmount);
            emit PrizePaid(dayId, index + 1, wallet, mattAmount);
        }

        emit DaySettled(dayId, totalPoolMatt, winnerCount);
    }

    function cancelDay(uint256 dayId)
        external
        override
        onlyRole(SETTLER_ROLE)
        nonReentrant
        whenSettlementNotPaused
    {
        Day storage day = _scheduledDay(dayId);
        uint256 seedReturnedMatt = day.seededMatt;

        day.status = DayStatus.Cancelled;
        day.reservedMatt -= seedReturnedMatt;
        totalReservedMatt -= seedReturnedMatt;

        if (seedReturnedMatt != 0) {
            matt.safeTransfer(seedTreasury, seedReturnedMatt);
        }

        emit DayCancelled(dayId, day.entryMatt, seedReturnedMatt);
    }

    function claimEntryRefund(uint256 dayId)
        external
        override
        nonReentrant
        returns (uint256 mattAmount)
    {
        Day storage day = _days[dayId];
        if (day.status != DayStatus.Cancelled) {
            revert DayNotCancelled(dayId);
        }

        WalletDay storage walletDay = _walletDays[dayId][msg.sender];
        mattAmount = walletDay.paidMatt - walletDay.refundedMatt;
        if (mattAmount == 0) {
            revert NoEntryRefundAvailable();
        }

        walletDay.refundedMatt += mattAmount;
        day.refundedMatt += mattAmount;
        day.reservedMatt -= mattAmount;
        totalReservedMatt -= mattAmount;

        matt.safeTransfer(msg.sender, mattAmount);

        emit EntryRefundClaimed(
            dayId,
            msg.sender,
            walletDay.entryCount,
            mattAmount
        );
    }

    function recoverExcess(uint256 mattAmount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
    {
        if (mattAmount == 0) {
            revert InvalidAmount();
        }

        uint256 availableMatt = availableExcessMatt();
        if (mattAmount > availableMatt) {
            revert ExcessMattUnavailable(availableMatt, mattAmount);
        }

        matt.safeTransfer(seedTreasury, mattAmount);
        emit ExcessMattRecovered(seedTreasury, mattAmount);
    }

    function setSeedTreasury(address newSeedTreasury)
        external
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (!entriesPaused || !settlementPaused) {
            revert FullPauseRequired();
        }
        if (totalReservedMatt != 0) {
            revert ReservedMattOutstanding(totalReservedMatt);
        }
        if (newSeedTreasury == address(0)) {
            revert InvalidAddress();
        }

        address previousSeedTreasury = seedTreasury;
        seedTreasury = newSeedTreasury;
        _revokeRole(TREASURY_ROLE, previousSeedTreasury);
        _grantRole(TREASURY_ROLE, newSeedTreasury);
        emit SeedTreasuryUpdated(previousSeedTreasury, newSeedTreasury);
    }

    function pauseEntries() external override onlyRole(PAUSER_ROLE) {
        if (entriesPaused) {
            revert EntriesAlreadyPaused();
        }
        entriesPaused = true;
        emit EntryPauseUpdated(true);
    }

    function unpauseEntries() external override onlyRole(PAUSER_ROLE) {
        if (!entriesPaused) {
            revert EntriesAlreadyUnpaused();
        }
        entriesPaused = false;
        emit EntryPauseUpdated(false);
    }

    function pauseSettlement() external override onlyRole(PAUSER_ROLE) {
        if (settlementPaused) {
            revert SettlementAlreadyPaused();
        }
        settlementPaused = true;
        emit SettlementPauseUpdated(true);
    }

    function unpauseSettlement() external override onlyRole(PAUSER_ROLE) {
        if (!settlementPaused) {
            revert SettlementAlreadyUnpaused();
        }
        settlementPaused = false;
        emit SettlementPauseUpdated(false);
    }

    function getDay(uint256 dayId) external view override returns (Day memory) {
        return _days[dayId];
    }

    function getWalletDay(uint256 dayId, address wallet)
        external
        view
        override
        returns (WalletDay memory)
    {
        return _walletDays[dayId][wallet];
    }

    function getEntry(uint256 entryNumber)
        external
        view
        override
        returns (Entry memory)
    {
        return _entries[entryNumber];
    }

    function getWinners(uint256 dayId)
        external
        view
        override
        returns (Winner[] memory)
    {
        return _winners[dayId];
    }

    function refundableMatt(uint256 dayId, address wallet)
        external
        view
        override
        returns (uint256)
    {
        if (_days[dayId].status != DayStatus.Cancelled) {
            return 0;
        }
        WalletDay storage walletDay = _walletDays[dayId][wallet];
        return walletDay.paidMatt - walletDay.refundedMatt;
    }

    function availableExcessMatt() public view override returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        return balance > totalReservedMatt ? balance - totalReservedMatt : 0;
    }

    function _scheduledDay(uint256 dayId) private view returns (Day storage day) {
        day = _days[dayId];
        if (day.status == DayStatus.Unscheduled) {
            revert DayNotScheduled(dayId);
        }
        if (day.status != DayStatus.Scheduled) {
            revert DayClosed(dayId);
        }
    }

    function _pullExact(address from, uint256 mattAmount) private {
        uint256 balanceBefore = matt.balanceOf(address(this));
        matt.safeTransferFrom(from, address(this), mattAmount);
        uint256 balanceAfter = matt.balanceOf(address(this));
        if (balanceAfter < balanceBefore) {
            revert TokenAccountingMismatch(mattAmount, 0);
        }
        uint256 receivedMatt = balanceAfter - balanceBefore;
        if (receivedMatt != mattAmount) {
            revert TokenAccountingMismatch(mattAmount, receivedMatt);
        }
    }

    receive() external payable {
        revert DirectPaymentDisabled();
    }

    fallback() external payable {
        revert DirectPaymentDisabled();
    }
}
