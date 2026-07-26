// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMattMineDailyArena {
    enum DayStatus {
        Unscheduled,
        Scheduled,
        Settled,
        Cancelled
    }

    struct Day {
        DayStatus status;
        uint256 entryFeeMatt;
        uint256 entryCount;
        uint256 entryMatt;
        uint256 seededMatt;
        uint256 reservedMatt;
        uint256 settledMatt;
        uint256 refundedMatt;
    }

    struct WalletDay {
        uint256 entryCount;
        uint256 paidMatt;
        uint256 refundedMatt;
    }

    struct Entry {
        uint256 dayId;
        address wallet;
        uint256 mattPaid;
    }

    struct Winner {
        address wallet;
        uint256 mattAmount;
    }

    event DayScheduled(uint256 indexed dayId, uint256 entryFeeMatt);
    event DaySeeded(
        uint256 indexed dayId,
        address indexed seedTreasury,
        uint256 mattAmount,
        uint256 totalSeededMatt,
        uint256 totalPoolMatt
    );
    event ContestEntered(
        uint256 indexed dayId,
        uint256 indexed entryNumber,
        address indexed wallet,
        uint256 mattPaid,
        uint256 totalPoolMatt
    );
    event DaySettled(
        uint256 indexed dayId,
        uint256 totalPoolMatt,
        uint256 winnerCount
    );
    event PrizePaid(
        uint256 indexed dayId,
        uint256 indexed rank,
        address indexed wallet,
        uint256 mattAmount
    );
    event DayCancelled(
        uint256 indexed dayId,
        uint256 refundableEntryMatt,
        uint256 seedReturnedMatt
    );
    event EntryRefundClaimed(
        uint256 indexed dayId,
        address indexed wallet,
        uint256 entryCount,
        uint256 mattAmount
    );
    event ExcessMattRecovered(address indexed seedTreasury, uint256 mattAmount);
    event SeedTreasuryUpdated(
        address indexed previousSeedTreasury,
        address indexed newSeedTreasury
    );
    event EntryPauseUpdated(bool isPaused);
    event SettlementPauseUpdated(bool isPaused);

    function matt() external view returns (IERC20);
    function seedTreasury() external view returns (address);
    function nextEntryNumber() external view returns (uint256);
    function totalReservedMatt() external view returns (uint256);
    function entriesPaused() external view returns (bool);
    function settlementPaused() external view returns (bool);
    function currentDayId() external view returns (uint256);
    function dayEnd(uint256 dayId) external pure returns (uint256);
    function entryCutoff(uint256 dayId) external pure returns (uint256);

    function scheduleDay(uint256 dayId, uint256 entryFeeMatt) external;
    function seedDay(uint256 dayId, uint256 mattAmount) external;
    function enter(uint256 dayId) external returns (uint256 entryNumber);
    function settleDay(
        uint256 dayId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external;
    function cancelDay(uint256 dayId) external;
    function claimEntryRefund(uint256 dayId) external returns (uint256 mattAmount);
    function recoverExcess(uint256 mattAmount) external;
    function setSeedTreasury(address newSeedTreasury) external;
    function pauseEntries() external;
    function unpauseEntries() external;
    function pauseSettlement() external;
    function unpauseSettlement() external;

    function getDay(uint256 dayId) external view returns (Day memory);
    function getWalletDay(uint256 dayId, address wallet)
        external
        view
        returns (WalletDay memory);
    function getEntry(uint256 entryNumber) external view returns (Entry memory);
    function getWinners(uint256 dayId) external view returns (Winner[] memory);
    function refundableMatt(uint256 dayId, address wallet)
        external
        view
        returns (uint256);
    function availableExcessMatt() external view returns (uint256);
}
