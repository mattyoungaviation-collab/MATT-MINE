// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMattMinePass} from "../interfaces/IMattMinePass.sol";

contract MattMinePass is IMattMinePass, AccessControl, Pausable, ReentrancyGuard {
    using Address for address payable;

    bytes32 public constant PRICE_MANAGER_ROLE = keccak256("PRICE_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint64 public constant PASS_DURATION = 30 days;
    uint64 public constant PRICE_UPDATE_COOLDOWN = 7 days;
    uint16 public constant OPERATIONS_BPS = 5_000;
    uint16 public constant REWARDS_BPS = 3_000;
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint256 public immutable minPassPriceRon;
    uint256 public immutable maxPassPriceRon;

    uint256 public override passPriceRon;
    uint64 public lastPassPriceUpdateAt;
    mapping(address player => uint64 expiresAt) public override passExpiresAt;

    address payable public operationsTreasury;
    address payable public rewardsTreasury;
    address payable public growthTreasury;

    error DirectPaymentDisabled();
    error IncorrectRonPayment(uint256 expected, uint256 received);
    error InvalidAddress();
    error InvalidPriceBounds();
    error PriceOutOfBounds(uint256 price);
    error PriceUpdateCooldownActive(uint256 nextUpdateAt);

    event PassPriceUpdated(uint256 previousPriceRon, uint256 newPriceRon);
    event RevenueRecipientsUpdated(
        address indexed operationsTreasury,
        address indexed rewardsTreasury,
        address indexed growthTreasury
    );
    event PassRevenueRouted(uint256 operationsRon, uint256 rewardsRon, uint256 growthRon);

    constructor(
        address initialAdmin,
        address priceManager,
        address pauser,
        address payable initialOperationsTreasury,
        address payable initialRewardsTreasury,
        address payable initialGrowthTreasury,
        uint256 initialPassPriceRon,
        uint256 minimumPassPriceRon,
        uint256 maximumPassPriceRon
    ) {
        if (
            initialAdmin == address(0) || priceManager == address(0) || pauser == address(0)
                || initialOperationsTreasury == address(0) || initialRewardsTreasury == address(0)
                || initialGrowthTreasury == address(0)
        ) {
            revert InvalidAddress();
        }
        if (
            minimumPassPriceRon == 0 || minimumPassPriceRon > maximumPassPriceRon
                || initialPassPriceRon < minimumPassPriceRon || initialPassPriceRon > maximumPassPriceRon
        ) {
            revert InvalidPriceBounds();
        }

        operationsTreasury = initialOperationsTreasury;
        rewardsTreasury = initialRewardsTreasury;
        growthTreasury = initialGrowthTreasury;
        passPriceRon = initialPassPriceRon;
        minPassPriceRon = minimumPassPriceRon;
        maxPassPriceRon = maximumPassPriceRon;

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(PRICE_MANAGER_ROLE, priceManager);
        _grantRole(PAUSER_ROLE, pauser);
    }

    function hasActivePass(address player) external view override returns (bool) {
        return passExpiresAt[player] > block.timestamp;
    }

    function purchasePass() external payable override nonReentrant whenNotPaused {
        uint256 price = passPriceRon;
        if (msg.value != price) {
            revert IncorrectRonPayment(price, msg.value);
        }

        uint256 currentExpiry = passExpiresAt[msg.sender];
        uint256 startAt = currentExpiry > block.timestamp ? currentExpiry : block.timestamp;
        uint64 newExpiry = uint64(startAt + PASS_DURATION);
        passExpiresAt[msg.sender] = newExpiry;

        uint256 operationsRon = (price * OPERATIONS_BPS) / BPS_DENOMINATOR;
        uint256 rewardsRon = (price * REWARDS_BPS) / BPS_DENOMINATOR;
        uint256 growthRon = price - operationsRon - rewardsRon;

        operationsTreasury.sendValue(operationsRon);
        rewardsTreasury.sendValue(rewardsRon);
        growthTreasury.sendValue(growthRon);

        emit PassPurchased(msg.sender, price, newExpiry);
        emit PassRevenueRouted(operationsRon, rewardsRon, growthRon);
    }

    function setPassPriceRon(uint256 newPriceRon) external onlyRole(PRICE_MANAGER_ROLE) {
        if (newPriceRon < minPassPriceRon || newPriceRon > maxPassPriceRon) {
            revert PriceOutOfBounds(newPriceRon);
        }
        uint256 nextUpdateAt = uint256(lastPassPriceUpdateAt) + PRICE_UPDATE_COOLDOWN;
        if (lastPassPriceUpdateAt != 0 && block.timestamp < nextUpdateAt) {
            revert PriceUpdateCooldownActive(nextUpdateAt);
        }
        uint256 previousPrice = passPriceRon;
        passPriceRon = newPriceRon;
        lastPassPriceUpdateAt = uint64(block.timestamp);
        emit PassPriceUpdated(previousPrice, newPriceRon);
    }

    function setRevenueRecipients(
        address payable newOperationsTreasury,
        address payable newRewardsTreasury,
        address payable newGrowthTreasury
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (
            newOperationsTreasury == address(0) || newRewardsTreasury == address(0)
                || newGrowthTreasury == address(0)
        ) {
            revert InvalidAddress();
        }
        operationsTreasury = newOperationsTreasury;
        rewardsTreasury = newRewardsTreasury;
        growthTreasury = newGrowthTreasury;
        emit RevenueRecipientsUpdated(newOperationsTreasury, newRewardsTreasury, newGrowthTreasury);
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
