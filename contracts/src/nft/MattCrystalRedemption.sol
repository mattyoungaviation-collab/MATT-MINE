// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureCheckerCompat} from "./libraries/SignatureCheckerCompat.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMattCrystal} from "./interfaces/IMattCrystal.sol";

/// @title MATT Crystal Redemption
/// @notice Redeems server-accounted crystals 1:1 with signed, rate-limited mint authorizations.
contract MattCrystalRedemption is AccessControlDefaultAdminRules, EIP712, Pausable, ReentrancyGuard {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    struct RedemptionReceipt {
        address player;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    struct DailyUsage {
        uint64 day;
        uint192 amount;
    }

    bytes32 public constant REDEMPTION_RECEIPT_TYPEHASH = keccak256(
        "RedemptionReceipt(address player,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    IMattCrystal public immutable crystal;
    address public redemptionSigner;
    uint256 public minimumWithdrawal;
    uint256 public maximumDailyWithdrawal;
    mapping(address player => uint256 nonce) public nonces;
    mapping(address player => DailyUsage usage) public dailyUsage;

    event CrystalsRedeemed(address indexed player, uint256 amount, uint256 indexed nonce, uint256 day);
    event RedemptionSignerUpdated(address indexed signer);
    event WithdrawalLimitsUpdated(uint256 minimumWithdrawal, uint256 maximumDailyWithdrawal);

    error ZeroAddress();
    error ReceiptExpired();
    error InvalidNonce();
    error InvalidSignature();
    error BelowMinimumWithdrawal();
    error DailyLimitExceeded();
    error InvalidLimits();
    error DailyAmountOverflow();

    constructor(
        address admin_,
        IMattCrystal crystal_,
        address redemptionSigner_,
        uint256 minimumWithdrawal_,
        uint256 maximumDailyWithdrawal_,
        address pauser_
    )
        AccessControlDefaultAdminRules(1 days, admin_)
        EIP712("MATT Crystal Redemption", "1")
    {
        if (address(crystal_) == address(0) || redemptionSigner_ == address(0) || pauser_ == address(0)) {
            revert ZeroAddress();
        }
        if (minimumWithdrawal_ == 0 || minimumWithdrawal_ > maximumDailyWithdrawal_) revert InvalidLimits();
        crystal = crystal_;
        redemptionSigner = redemptionSigner_;
        minimumWithdrawal = minimumWithdrawal_;
        maximumDailyWithdrawal = maximumDailyWithdrawal_;
        _grantRole(PAUSER_ROLE, admin_);
        _grantRole(PAUSER_ROLE, pauser_);
        _pause();
    }

    function redeem(RedemptionReceipt calldata receipt, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        if (receipt.player != msg.sender) revert InvalidSignature();
        if (block.timestamp > receipt.deadline) revert ReceiptExpired();
        if (receipt.nonce != nonces[receipt.player]) revert InvalidNonce();
        if (receipt.amount < minimumWithdrawal) revert BelowMinimumWithdrawal();

        bytes32 structHash = keccak256(
            abi.encode(
                REDEMPTION_RECEIPT_TYPEHASH,
                receipt.player,
                receipt.amount,
                receipt.nonce,
                receipt.deadline
            )
        );
        if (!SignatureCheckerCompat.isValidSignatureNow(redemptionSigner, _hashTypedDataV4(structHash), signature)) {
            revert InvalidSignature();
        }

        uint64 day = uint64(block.timestamp / 1 days);
        DailyUsage memory usage = dailyUsage[receipt.player];
        uint256 alreadyRedeemed = usage.day == day ? usage.amount : 0;
        uint256 newDailyAmount = alreadyRedeemed + receipt.amount;
        if (newDailyAmount > maximumDailyWithdrawal) revert DailyLimitExceeded();
        if (newDailyAmount > type(uint192).max) revert DailyAmountOverflow();

        nonces[receipt.player] = receipt.nonce + 1;
        dailyUsage[receipt.player] = DailyUsage({day: day, amount: uint192(newDailyAmount)});
        crystal.mint(receipt.player, receipt.amount);
        emit CrystalsRedeemed(receipt.player, receipt.amount, receipt.nonce, day);
    }

    function setRedemptionSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (signer == address(0)) revert ZeroAddress();
        redemptionSigner = signer;
        emit RedemptionSignerUpdated(signer);
    }

    function setWithdrawalLimits(uint256 minimum, uint256 dailyMaximum)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (minimum == 0 || minimum > dailyMaximum) revert InvalidLimits();
        minimumWithdrawal = minimum;
        maximumDailyWithdrawal = dailyMaximum;
        emit WithdrawalLimitsUpdated(minimum, dailyMaximum);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
