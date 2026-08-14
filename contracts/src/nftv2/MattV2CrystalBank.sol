// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IMattCrystal} from "../nft/interfaces/IMattCrystal.sol";
import {MattV2UpgradeableModule} from "./base/MattV2UpgradeableModule.sol";

/// @title MATT Mine Crystal Bank V2
/// @notice Wallet-owned gameplay balances with bounded mint-on-withdrawal.
contract MattV2CrystalBank is MattV2UpgradeableModule {
    bytes32 public constant CREDIT_ROLE = keccak256("CREDIT_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    uint256 public constant HARD_WALLET_DAILY_TOKENS = 1_000_000;
    uint256 public constant HARD_GLOBAL_DAILY_TOKENS = 100_000_000;

    IMattCrystal public crystal;
    uint256 public tokenUnit;
    uint256 public minimumWithdrawal;
    uint256 public walletDailyLimit;
    uint256 public globalDailyLimit;

    mapping(address wallet => uint256 amount) public bankBalance;
    mapping(uint256 utcDay => mapping(address wallet => uint256 amount)) public walletWithdrawn;
    mapping(uint256 utcDay => uint256 amount) public globalWithdrawn;
    mapping(bytes32 runId => bool credited) public creditedRuns;

    event CrystalBankCredited(address indexed player, bytes32 indexed runId, uint256 amount, uint256 balance);
    event CrystalWithdrawn(address indexed player, uint256 indexed utcDay, uint256 amount, uint256 balance);
    event WithdrawalConfigurationUpdated(uint256 minimum, uint256 walletDailyLimit, uint256 globalDailyLimit);

    error InvalidToken();
    error InvalidConfiguration();
    error RunAlreadyCredited();
    error WithdrawalTooSmall();
    error InsufficientBankBalance();
    error WalletDailyLimitExceeded();
    error GlobalDailyLimitExceeded();

    constructor(address upgradeTimelock) MattV2UpgradeableModule(upgradeTimelock) {}

    function initialize(
        address admin,
        address pauser,
        address creditSource,
        address configOperator,
        IMattCrystal crystal_
    ) external initializer {
        __MattV2UpgradeableModule_init(admin, pauser);
        if (creditSource == address(0) || configOperator == address(0) || address(crystal_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(crystal_).code.length == 0) revert InvalidToken();
        uint8 decimals = IERC20Metadata(address(crystal_)).decimals();
        if (decimals > 18) revert InvalidToken();
        crystal = crystal_;
        tokenUnit = 10 ** decimals;
        minimumWithdrawal = 100 * tokenUnit;
        walletDailyLimit = 100_000 * tokenUnit;
        globalDailyLimit = 10_000_000 * tokenUnit;
        _grantRole(CREDIT_ROLE, admin);
        _grantRole(CREDIT_ROLE, creditSource);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(CONFIG_ROLE, configOperator);
        emit WithdrawalConfigurationUpdated(minimumWithdrawal, walletDailyLimit, globalDailyLimit);
    }

    function credit(address player, uint256 amount, bytes32 runId) external onlyRole(CREDIT_ROLE) whenNotPaused {
        if (player == address(0) || runId == bytes32(0)) revert InvalidConfiguration();
        if (creditedRuns[runId]) revert RunAlreadyCredited();
        creditedRuns[runId] = true;
        bankBalance[player] += amount;
        emit CrystalBankCredited(player, runId, amount, bankBalance[player]);
    }

    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount < minimumWithdrawal) revert WithdrawalTooSmall();
        uint256 balance = bankBalance[msg.sender];
        if (amount > balance) revert InsufficientBankBalance();
        uint256 utcDay = block.timestamp / 1 days;
        uint256 newWalletTotal = walletWithdrawn[utcDay][msg.sender] + amount;
        if (newWalletTotal > walletDailyLimit) revert WalletDailyLimitExceeded();
        uint256 newGlobalTotal = globalWithdrawn[utcDay] + amount;
        if (newGlobalTotal > globalDailyLimit) revert GlobalDailyLimitExceeded();

        bankBalance[msg.sender] = balance - amount;
        walletWithdrawn[utcDay][msg.sender] = newWalletTotal;
        globalWithdrawn[utcDay] = newGlobalTotal;
        crystal.mint(msg.sender, amount);
        emit CrystalWithdrawn(msg.sender, utcDay, amount, balance - amount);
    }

    function setWithdrawalConfiguration(uint256 minimum, uint256 walletLimit, uint256 globalLimit)
        external
        onlyRole(CONFIG_ROLE)
    {
        uint256 unit = tokenUnit;
        if (
            minimum < unit || walletLimit < minimum || globalLimit < walletLimit
                || walletLimit > HARD_WALLET_DAILY_TOKENS * unit
                || globalLimit > HARD_GLOBAL_DAILY_TOKENS * unit
        ) revert InvalidConfiguration();
        minimumWithdrawal = minimum;
        walletDailyLimit = walletLimit;
        globalDailyLimit = globalLimit;
        emit WithdrawalConfigurationUpdated(minimum, walletLimit, globalLimit);
    }

    uint256[42] private __gap;
}
