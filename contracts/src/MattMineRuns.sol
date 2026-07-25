// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMattMinePass} from "../interfaces/IMattMinePass.sol";
import {IMattMineRuns} from "../interfaces/IMattMineRuns.sol";
import {IMattMineSwapExecutor} from "../interfaces/IMattMineSwapExecutor.sol";

contract MattMineRuns is IMattMineRuns, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PRICE_MANAGER_ROLE = keccak256("PRICE_MANAGER_ROLE");
    bytes32 public constant CONFIG_MANAGER_ROLE = keccak256("CONFIG_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 public constant MAX_DAILY_PAID_RUNS = 10;
    uint16 public constant CURRENT_REWARDS_BPS = 7_000;
    uint16 public constant FUTURE_REWARDS_BPS = 2_000;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_DEADLINE_WINDOW = 15 minutes;
    uint256 public constant PRICE_UPDATE_COOLDOWN = 7 days;

    IMattMinePass public immutable passContract;
    IERC20 public immutable mattToken;

    IMattMineSwapExecutor public swapExecutor;
    address public currentRewardsVault;
    address public futureRewardsTreasury;
    address public reserveTreasury;

    uint256 public immutable minPaidRunPriceRon;
    uint256 public immutable maxPaidRunPriceRon;
    uint256 public override paidRunPriceRon;
    uint64 public lastPaidRunPriceUpdateAt;
    uint256 public nextEntitlementId = 1;

    struct DailyRuns {
        uint64 day;
        uint8 count;
    }

    mapping(address player => DailyRuns runs) private _dailyRuns;

    error ActivePassRequired();
    error DailyRunLimitReached();
    error DirectPaymentDisabled();
    error IncorrectRonPayment(uint256 expected, uint256 received);
    error InvalidAddress();
    error InvalidDeadline(uint256 deadline);
    error InvalidMinimumOutput();
    error InvalidPriceBounds();
    error PriceOutOfBounds(uint256 price);
    error PriceUpdateCooldownActive(uint256 nextUpdateAt);
    error SwapAccountingMismatch(uint256 reportedMatt, uint256 receivedMatt);

    event PaidRunPriceUpdated(uint256 previousPriceRon, uint256 newPriceRon);
    event SwapExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event RewardDestinationsUpdated(
        address indexed currentRewardsVault,
        address indexed futureRewardsTreasury,
        address indexed reserveTreasury
    );

    constructor(
        address passAddress,
        address mattAddress,
        address executorAddress,
        address initialAdmin,
        address priceManager,
        address configManager,
        address pauser,
        address initialCurrentRewardsVault,
        address initialFutureRewardsTreasury,
        address initialReserveTreasury,
        uint256 initialPaidRunPriceRon,
        uint256 minimumPaidRunPriceRon,
        uint256 maximumPaidRunPriceRon
    ) {
        if (
            passAddress == address(0) || mattAddress == address(0) || executorAddress == address(0)
                || initialAdmin == address(0) || priceManager == address(0) || configManager == address(0)
                || pauser == address(0) || initialCurrentRewardsVault == address(0)
                || initialFutureRewardsTreasury == address(0) || initialReserveTreasury == address(0)
                || passAddress.code.length == 0 || mattAddress.code.length == 0 || executorAddress.code.length == 0
        ) {
            revert InvalidAddress();
        }
        if (
            minimumPaidRunPriceRon == 0 || minimumPaidRunPriceRon > maximumPaidRunPriceRon
                || initialPaidRunPriceRon < minimumPaidRunPriceRon
                || initialPaidRunPriceRon > maximumPaidRunPriceRon
        ) {
            revert InvalidPriceBounds();
        }

        passContract = IMattMinePass(passAddress);
        mattToken = IERC20(mattAddress);
        swapExecutor = IMattMineSwapExecutor(executorAddress);
        currentRewardsVault = initialCurrentRewardsVault;
        futureRewardsTreasury = initialFutureRewardsTreasury;
        reserveTreasury = initialReserveTreasury;
        paidRunPriceRon = initialPaidRunPriceRon;
        minPaidRunPriceRon = minimumPaidRunPriceRon;
        maxPaidRunPriceRon = maximumPaidRunPriceRon;

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(PRICE_MANAGER_ROLE, priceManager);
        _grantRole(CONFIG_MANAGER_ROLE, configManager);
        _grantRole(PAUSER_ROLE, pauser);
    }

    function purchasePaidRun(uint256 minMattOut, uint256 deadline)
        external
        payable
        override
        nonReentrant
        whenNotPaused
        returns (uint256 entitlementId)
    {
        if (!passContract.hasActivePass(msg.sender)) {
            revert ActivePassRequired();
        }

        uint256 price = paidRunPriceRon;
        if (msg.value != price) {
            revert IncorrectRonPayment(price, msg.value);
        }
        if (minMattOut == 0) {
            revert InvalidMinimumOutput();
        }
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_DEADLINE_WINDOW) {
            revert InvalidDeadline(deadline);
        }

        uint64 today = uint64(block.timestamp / 1 days);
        DailyRuns storage runs = _dailyRuns[msg.sender];
        if (runs.day != today) {
            runs.day = today;
            runs.count = 0;
        }
        if (runs.count >= MAX_DAILY_PAID_RUNS) {
            revert DailyRunLimitReached();
        }
        runs.count += 1;

        uint256 balanceBefore = mattToken.balanceOf(address(this));
        uint256 reportedMatt = swapExecutor.swapRonForMatt{value: msg.value}(minMattOut, deadline);
        uint256 receivedMatt = mattToken.balanceOf(address(this)) - balanceBefore;
        if (reportedMatt != receivedMatt || receivedMatt < minMattOut) {
            revert SwapAccountingMismatch(reportedMatt, receivedMatt);
        }

        uint256 currentPoolMatt = (receivedMatt * CURRENT_REWARDS_BPS) / BPS_DENOMINATOR;
        uint256 futureRewardsMatt = (receivedMatt * FUTURE_REWARDS_BPS) / BPS_DENOMINATOR;
        uint256 reserveMatt = receivedMatt - currentPoolMatt - futureRewardsMatt;

        mattToken.safeTransfer(currentRewardsVault, currentPoolMatt);
        mattToken.safeTransfer(futureRewardsTreasury, futureRewardsMatt);
        mattToken.safeTransfer(reserveTreasury, reserveMatt);

        entitlementId = nextEntitlementId++;
        emit PaidRunPurchased(
            msg.sender,
            entitlementId,
            msg.value,
            receivedMatt,
            currentPoolMatt,
            futureRewardsMatt,
            reserveMatt
        );
    }

    function paidRunsToday(address player) external view returns (uint8) {
        DailyRuns memory runs = _dailyRuns[player];
        return runs.day == uint64(block.timestamp / 1 days) ? runs.count : 0;
    }

    function setPaidRunPriceRon(uint256 newPriceRon) external onlyRole(PRICE_MANAGER_ROLE) {
        if (newPriceRon < minPaidRunPriceRon || newPriceRon > maxPaidRunPriceRon) {
            revert PriceOutOfBounds(newPriceRon);
        }
        uint256 nextUpdateAt = uint256(lastPaidRunPriceUpdateAt) + PRICE_UPDATE_COOLDOWN;
        if (lastPaidRunPriceUpdateAt != 0 && block.timestamp < nextUpdateAt) {
            revert PriceUpdateCooldownActive(nextUpdateAt);
        }
        uint256 previousPrice = paidRunPriceRon;
        paidRunPriceRon = newPriceRon;
        lastPaidRunPriceUpdateAt = uint64(block.timestamp);
        emit PaidRunPriceUpdated(previousPrice, newPriceRon);
    }

    function setSwapExecutor(address newExecutor) external onlyRole(CONFIG_MANAGER_ROLE) whenPaused {
        if (newExecutor == address(0) || newExecutor.code.length == 0) {
            revert InvalidAddress();
        }
        address previousExecutor = address(swapExecutor);
        swapExecutor = IMattMineSwapExecutor(newExecutor);
        emit SwapExecutorUpdated(previousExecutor, newExecutor);
    }

    function setRewardDestinations(
        address newCurrentRewardsVault,
        address newFutureRewardsTreasury,
        address newReserveTreasury
    ) external onlyRole(CONFIG_MANAGER_ROLE) whenPaused {
        if (
            newCurrentRewardsVault == address(0) || newFutureRewardsTreasury == address(0)
                || newReserveTreasury == address(0)
        ) {
            revert InvalidAddress();
        }
        currentRewardsVault = newCurrentRewardsVault;
        futureRewardsTreasury = newFutureRewardsTreasury;
        reserveTreasury = newReserveTreasury;
        emit RewardDestinationsUpdated(
            newCurrentRewardsVault, newFutureRewardsTreasury, newReserveTreasury
        );
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    receive() external payable {
        revert DirectPaymentDisabled();
    }

    fallback() external payable {
        revert DirectPaymentDisabled();
    }
}
