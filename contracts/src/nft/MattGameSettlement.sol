// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureCheckerCompat} from "./libraries/SignatureCheckerCompat.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MattMiner} from "./MattMiner.sol";
import {MattLoadout} from "./MattLoadout.sol";

/// @title MATT Mine Run Settlement
/// @notice Applies server-signed, replay-protected extraction and death results.
contract MattGameSettlement is AccessControlDefaultAdminRules, EIP712, Pausable, ReentrancyGuard {
    bytes32 public constant RUN_MANAGER_ROLE = keccak256("RUN_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum Outcome {
        Extraction,
        Death
    }

    struct RunReceipt {
        address player;
        uint256 minerId;
        bytes32 runId;
        Outcome outcome;
        uint8 completedPhases;
        uint256 xpDelta;
        uint8 newLevel;
        uint256 crystalsCarried;
        uint256 crystalsBanked;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant RUN_RECEIPT_TYPEHASH = keccak256(
        "RunReceipt(address player,uint256 minerId,bytes32 runId,uint8 outcome,uint8 completedPhases,uint256 xpDelta,uint8 newLevel,uint256 crystalsCarried,uint256 crystalsBanked,uint256 nonce,uint256 deadline)"
    );

    MattMiner public immutable miner;
    MattLoadout public immutable loadout;
    address public gameSigner;
    mapping(address player => uint256 nonce) public nonces;
    mapping(bytes32 runId => bool processed) public processedRuns;

    event RunSettled(
        bytes32 indexed runId,
        address indexed player,
        uint256 indexed minerId,
        Outcome outcome,
        uint8 completedPhases,
        uint256 xpDelta,
        uint8 newLevel,
        uint256 crystalsBanked
    );
    event GameSignerUpdated(address indexed signer);
    event RunStarted(uint256 indexed minerId);
    event RunCancelled(uint256 indexed minerId);

    error ZeroAddress();
    error ReceiptExpired();
    error InvalidNonce();
    error RunAlreadyProcessed();
    error PlayerNoLongerOwnsMiner();
    error InvalidSignature();
    error InvalidDeathSettlement();
    error InvalidExtractionSettlement();
    error RunNotLocked();
    error InvalidPhaseMask();

    constructor(
        address admin_,
        MattMiner miner_,
        MattLoadout loadout_,
        address gameSigner_,
        address gameOperator_,
        address pauser_
    )
        AccessControlDefaultAdminRules(1 days, admin_)
        EIP712("MATT Mine Run Settlement", "1")
    {
        if (
            address(miner_) == address(0) || address(loadout_) == address(0) || gameSigner_ == address(0)
                || gameOperator_ == address(0) || pauser_ == address(0)
        ) revert ZeroAddress();
        miner = miner_;
        loadout = loadout_;
        gameSigner = gameSigner_;
        _grantRole(RUN_MANAGER_ROLE, gameOperator_);
        _grantRole(PAUSER_ROLE, admin_);
        _grantRole(PAUSER_ROLE, pauser_);
        _pause();
    }

    function beginRun(uint256 minerId) external onlyRole(RUN_MANAGER_ROLE) whenNotPaused {
        loadout.setRunLocked(minerId, true);
        emit RunStarted(minerId);
    }

    function cancelRun(uint256 minerId) external onlyRole(RUN_MANAGER_ROLE) {
        loadout.setRunLocked(minerId, false);
        emit RunCancelled(minerId);
    }

    function settleRun(RunReceipt calldata receipt, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        if (block.timestamp > receipt.deadline) revert ReceiptExpired();
        if (receipt.nonce != nonces[receipt.player]) revert InvalidNonce();
        if (processedRuns[receipt.runId]) revert RunAlreadyProcessed();
        if (miner.ownerOf(receipt.minerId) != receipt.player) revert PlayerNoLongerOwnsMiner();
        if (!loadout.isRunLocked(receipt.minerId)) revert RunNotLocked();

        bytes32 structHash = keccak256(
            abi.encode(
                RUN_RECEIPT_TYPEHASH,
                receipt.player,
                receipt.minerId,
                receipt.runId,
                receipt.outcome,
                receipt.completedPhases,
                receipt.xpDelta,
                receipt.newLevel,
                receipt.crystalsCarried,
                receipt.crystalsBanked,
                receipt.nonce,
                receipt.deadline
            )
        );
        if (!SignatureCheckerCompat.isValidSignatureNow(gameSigner, _hashTypedDataV4(structHash), signature)) {
            revert InvalidSignature();
        }

        if (receipt.completedPhases > 0x1f) revert InvalidPhaseMask();
        (, uint8 currentLevel,,) = miner.progressionOf(receipt.minerId);
        bool hasBackpack = loadout.activeBackpack(receipt.minerId) != 0;
        if (receipt.outcome == Outcome.Death) {
            uint256 expectedBanked = hasBackpack ? receipt.crystalsCarried / 2 : 0;
            if (receipt.xpDelta != 0 || receipt.newLevel != currentLevel || receipt.crystalsBanked != expectedBanked) {
                revert InvalidDeathSettlement();
            }
        } else if (
            receipt.crystalsBanked != receipt.crystalsCarried
                || receipt.xpDelta != xpForCompletedPhases(receipt.completedPhases)
        ) {
            revert InvalidExtractionSettlement();
        }

        processedRuns[receipt.runId] = true;
        nonces[receipt.player] = receipt.nonce + 1;

        if (receipt.outcome == Outcome.Death) {
            loadout.applyDeath(receipt.minerId);
        } else {
            miner.applyProgression(receipt.minerId, receipt.xpDelta, receipt.newLevel);
            loadout.applyExtraction(receipt.minerId);
        }

        emit RunSettled(
            receipt.runId,
            receipt.player,
            receipt.minerId,
            receipt.outcome,
            receipt.completedPhases,
            receipt.xpDelta,
            receipt.newLevel,
            receipt.crystalsBanked
        );
    }

    function xpForCompletedPhases(uint8 completedPhases) public pure returns (uint256 xp) {
        if (completedPhases > 0x1f) revert InvalidPhaseMask();
        if (completedPhases & 0x01 != 0) xp += 10;
        if (completedPhases & 0x02 != 0) xp += 12;
        if (completedPhases & 0x04 != 0) xp += 15;
        if (completedPhases & 0x08 != 0) xp += 18;
        if (completedPhases & 0x10 != 0) xp += 25;
    }

    function setGameSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (signer == address(0)) revert ZeroAddress();
        gameSigner = signer;
        emit GameSignerUpdated(signer);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
