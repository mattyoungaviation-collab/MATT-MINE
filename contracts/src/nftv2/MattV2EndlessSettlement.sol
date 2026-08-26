// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SignatureCheckerCompat} from "../nft/libraries/SignatureCheckerCompat.sol";
import {MattV2UpgradeableModule} from "./base/MattV2UpgradeableModule.sol";
import {MattV2Miner} from "./MattV2Miner.sol";
import {MattV2Loadout} from "./MattV2Loadout.sol";
import {IMattV2CrystalBank} from "./interfaces/IMattV2CrystalBank.sol";
import {IMattV2PassiveRewards} from "./interfaces/IMattV2PassiveRewards.sol";
import {MattV2Types} from "./libraries/MattV2Types.sol";

/// @title MATT Mine Endless Settlement
/// @notice V2-compatible, progressive settlement for server-verified runs that can exceed five phases.
/// @dev This is separate from MattV2GameSettlement so the deployed V2 module remains storage-safe and
///      below the EVM code-size ceiling. Both modules enforce the same Miner-level run lock.
contract MattV2EndlessSettlement is MattV2UpgradeableModule, EIP712Upgradeable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    uint256 public constant HARD_RUN_PAYOUT_TOKENS = 100_000;
    uint256 public constant HARD_DAILY_PAYOUT_TOKENS = 10_000_000;
    uint256 public constant HARD_CONVERSION_TOKENS = 100_000;
    uint32 public constant MAX_PHASES = 1_000_000;
    uint32 public constant MAX_PHASE_XP = 1_000_000;
    uint32 public constant MAX_RUN_XP = 1_000_000;
    uint32 public constant MIN_CHECKPOINT_TIMEOUT = 5 minutes;
    uint32 public constant MAX_CHECKPOINT_TIMEOUT = 7 days;

    bytes32 public constant RUN_AUTHORIZATION_TYPEHASH = keccak256(
        "EndlessRunAuthorization(address player,uint256 minerId,bytes32 versionId,bytes32 loadoutHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CHECKPOINT_TYPEHASH = keccak256(
        "EndlessCheckpoint(address player,uint256 minerId,bytes32 runId,bytes32 versionId,bytes32 previousDigest,bytes32 checkpointDigest,uint32 completedPhases,uint32 minedCrystalUnits,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "EndlessResult(address player,uint256 minerId,bytes32 runId,bytes32 versionId,bytes32 checkpointDigest,uint8 outcome,uint32 completedPhases,uint32 minedCrystalUnits,uint256 nonce,uint256 deadline)"
    );

    struct EndlessVersion {
        bytes32 generatorHash;
        bytes32 configHash;
        uint128 conversionRate;
        uint128 maximumPayout;
        uint128 maximumDailyPayout;
        uint32 mineableCrystalUnits;
        uint32 maximumPhases;
        uint32 phaseXp;
        uint32 maximumRunXp;
        uint32 maximumWalletXpPerDay;
        uint32 maximumMinerXpPerDay;
        uint32 checkpointTimeout;
        bool failedRunsRetainXp;
        bool approved;
        bool retired;
    }

    struct EndlessRunAuthorization {
        address player;
        uint256 minerId;
        bytes32 versionId;
        bytes32 loadoutHash;
        uint256 nonce;
        uint256 deadline;
    }

    struct EndlessCheckpoint {
        address player;
        uint256 minerId;
        bytes32 runId;
        bytes32 versionId;
        bytes32 previousDigest;
        bytes32 checkpointDigest;
        uint32 completedPhases;
        uint32 minedCrystalUnits;
        uint256 nonce;
        uint256 deadline;
    }

    struct EndlessResult {
        address player;
        uint256 minerId;
        bytes32 runId;
        bytes32 versionId;
        bytes32 checkpointDigest;
        MattV2Types.Outcome outcome;
        uint32 completedPhases;
        uint32 minedCrystalUnits;
        uint256 nonce;
        uint256 deadline;
    }

    struct ActiveEndlessRun {
        bytes32 runId;
        bytes32 versionId;
        bytes32 loadoutHash;
        bytes32 checkpointDigest;
        address player;
        uint128 conversionRate;
        uint128 maximumPayout;
        uint128 maximumDailyPayout;
        uint40 startedAt;
        uint40 lastCheckpointAt;
        uint32 mineableCrystalUnits;
        uint32 maximumPhases;
        uint32 phaseXp;
        uint32 maximumRunXp;
        uint32 maximumWalletXpPerDay;
        uint32 maximumMinerXpPerDay;
        uint32 checkpointTimeout;
        uint32 completedPhases;
        uint32 minedCrystalUnits;
        uint16 carryCapacity;
        uint16 deathRetentionBps;
        bool failedRunsRetainXp;
        uint256 nonce;
    }

    MattV2Miner public miner;
    MattV2Loadout public loadout;
    IMattV2CrystalBank public crystalBank;
    IMattV2PassiveRewards public passiveRewards;
    address public rewardSigner;
    uint256 public crystalUnit;

    mapping(bytes32 versionId => EndlessVersion version) public versions;
    mapping(uint256 minerId => ActiveEndlessRun run) private _activeRuns;
    mapping(address player => uint256 nonce) public playerNonces;
    mapping(bytes32 runId => bool processed) public processedRuns;
    mapping(uint256 day => uint256 amount) public crystalsBankedByDay;
    mapping(address player => mapping(uint256 day => uint32 amount)) public walletXpByDay;
    mapping(uint256 minerId => mapping(uint256 day => uint32 amount)) public minerXpByDay;

    event EndlessVersionApproved(
        bytes32 indexed versionId,
        bytes32 indexed generatorHash,
        bytes32 indexed configHash,
        uint32 maximumPhases,
        uint32 phaseXp,
        uint32 maximumRunXp
    );
    event EndlessVersionRetired(bytes32 indexed versionId);
    event EndlessRunStarted(
        bytes32 indexed runId,
        address indexed player,
        uint256 indexed minerId,
        bytes32 versionId,
        bytes32 loadoutHash,
        uint16 carryCapacity
    );
    event EndlessCheckpointAccepted(
        bytes32 indexed runId,
        uint256 indexed minerId,
        uint32 completedPhases,
        uint32 minedCrystalUnits,
        bytes32 checkpointDigest
    );
    event EndlessRunSettled(
        bytes32 indexed runId,
        address indexed player,
        uint256 indexed minerId,
        MattV2Types.Outcome outcome,
        uint32 completedPhases,
        uint32 minedCrystalUnits,
        uint256 xpBanked,
        uint256 crystalsBanked,
        bytes32 checkpointDigest
    );
    event EndlessRunForceAbandoned(bytes32 indexed runId, address indexed player, uint256 indexed minerId);
    event RewardSignerUpdated(address indexed signer);

    error InvalidConfiguration();
    error InvalidVersion();
    error VersionAlreadyExists();
    error VersionUnavailable();
    error AuthorizationExpired();
    error InvalidNonce();
    error InvalidSignature();
    error NotMinerOwner();
    error RunAlreadyActive();
    error RunNotActive();
    error RunMismatch();
    error RunAlreadyProcessed();
    error InvalidRunResult();
    error ForceAbandonTooEarly();
    error UnsafeRoleOverlap();

    constructor(address upgradeTimelock) MattV2UpgradeableModule(upgradeTimelock) {}

    function initialize(
        address admin,
        address pauser,
        address gameOperator,
        address configOperator,
        address rewardSigner_,
        MattV2Miner miner_,
        MattV2Loadout loadout_,
        IMattV2CrystalBank crystalBank_,
        IMattV2PassiveRewards passiveRewards_
    ) external initializer {
        __MattV2UpgradeableModule_init(admin, pauser);
        __EIP712_init("MATT Mine V2 Endless Settlement", "1");
        if (
            gameOperator == address(0) || configOperator == address(0) || rewardSigner_ == address(0)
                || address(miner_) == address(0) || address(loadout_) == address(0)
                || address(crystalBank_) == address(0) || address(passiveRewards_) == address(0)
        ) revert ZeroAddress();
        if (
            address(miner_).code.length == 0 || address(loadout_).code.length == 0
                || address(crystalBank_).code.length == 0 || address(passiveRewards_).code.length == 0
        ) revert InvalidConfiguration();
        miner = miner_;
        loadout = loadout_;
        crystalBank = crystalBank_;
        passiveRewards = passiveRewards_;
        rewardSigner = rewardSigner_;
        crystalUnit = crystalBank_.tokenUnit();
        if (crystalUnit == 0) revert InvalidConfiguration();
        _grantRole(OPERATOR_ROLE, admin);
        _grantRole(OPERATOR_ROLE, gameOperator);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(CONFIG_ROLE, configOperator);
        emit RewardSignerUpdated(rewardSigner_);
    }

    function approveVersion(EndlessVersion calldata input) external onlyRole(CONFIG_ROLE) returns (bytes32 versionId) {
        uint256 unit = crystalUnit;
        if (
            input.generatorHash == bytes32(0) || input.configHash == bytes32(0)
                || input.conversionRate == 0 || input.conversionRate > HARD_CONVERSION_TOKENS * unit
                || input.maximumPayout == 0 || input.maximumPayout > HARD_RUN_PAYOUT_TOKENS * unit
                || input.maximumDailyPayout == 0
                || input.maximumDailyPayout > HARD_DAILY_PAYOUT_TOKENS * unit
                || input.mineableCrystalUnits == 0 || input.maximumPhases == 0
                || input.maximumPhases > MAX_PHASES || input.phaseXp > MAX_PHASE_XP
                || input.maximumRunXp == 0 || input.maximumRunXp > MAX_RUN_XP
                || input.maximumWalletXpPerDay == 0 || input.maximumMinerXpPerDay == 0
                || input.checkpointTimeout < MIN_CHECKPOINT_TIMEOUT
                || input.checkpointTimeout > MAX_CHECKPOINT_TIMEOUT || input.approved || input.retired
        ) revert InvalidConfiguration();
        versionId = keccak256(
            abi.encode(
                input.generatorHash,
                input.configHash,
                input.conversionRate,
                input.maximumPayout,
                input.maximumDailyPayout,
                input.mineableCrystalUnits,
                input.maximumPhases,
                input.phaseXp,
                input.maximumRunXp,
                input.maximumWalletXpPerDay,
                input.maximumMinerXpPerDay,
                input.checkpointTimeout,
                input.failedRunsRetainXp
            )
        );
        if (versions[versionId].approved) revert VersionAlreadyExists();
        versions[versionId] = EndlessVersion({
            generatorHash: input.generatorHash,
            configHash: input.configHash,
            conversionRate: input.conversionRate,
            maximumPayout: input.maximumPayout,
            maximumDailyPayout: input.maximumDailyPayout,
            mineableCrystalUnits: input.mineableCrystalUnits,
            maximumPhases: input.maximumPhases,
            phaseXp: input.phaseXp,
            maximumRunXp: input.maximumRunXp,
            maximumWalletXpPerDay: input.maximumWalletXpPerDay,
            maximumMinerXpPerDay: input.maximumMinerXpPerDay,
            checkpointTimeout: input.checkpointTimeout,
            failedRunsRetainXp: input.failedRunsRetainXp,
            approved: true,
            retired: false
        });
        emit EndlessVersionApproved(
            versionId,
            input.generatorHash,
            input.configHash,
            input.maximumPhases,
            input.phaseXp,
            input.maximumRunXp
        );
    }

    function retireVersion(bytes32 versionId) external onlyRole(CONFIG_ROLE) {
        EndlessVersion storage version = versions[versionId];
        if (!version.approved || version.retired) revert InvalidVersion();
        version.retired = true;
        emit EndlessVersionRetired(versionId);
    }

    function beginRun(EndlessRunAuthorization calldata authorization, bytes calldata playerSignature)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
        returns (bytes32 runId)
    {
        _requireSafeRoleSplit();
        if (block.timestamp > authorization.deadline) revert AuthorizationExpired();
        if (authorization.nonce != playerNonces[authorization.player]) revert InvalidNonce();
        if (miner.ownerOf(authorization.minerId) != authorization.player) revert NotMinerOwner();
        if (_activeRuns[authorization.minerId].runId != bytes32(0) || miner.isRunLocked(authorization.minerId)) {
            revert RunAlreadyActive();
        }
        EndlessVersion memory version = versions[authorization.versionId];
        if (!version.approved || version.retired) revert VersionUnavailable();
        bytes32 currentLoadoutHash = loadout.loadoutHash(authorization.minerId);
        if (currentLoadoutHash != authorization.loadoutHash) revert RunMismatch();
        if (!_validAuthorization(authorization, playerSignature)) revert InvalidSignature();

        MattV2Loadout.EffectiveTraits memory traits = loadout.effectiveTraits(authorization.minerId);
        runId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                authorization.player,
                authorization.minerId,
                authorization.versionId,
                authorization.nonce
            )
        );
        if (processedRuns[runId]) revert RunAlreadyProcessed();
        playerNonces[authorization.player] = authorization.nonce + 1;
        _activeRuns[authorization.minerId] = ActiveEndlessRun({
            runId: runId,
            versionId: authorization.versionId,
            loadoutHash: authorization.loadoutHash,
            checkpointDigest: bytes32(0),
            player: authorization.player,
            conversionRate: version.conversionRate,
            maximumPayout: version.maximumPayout,
            maximumDailyPayout: version.maximumDailyPayout,
            startedAt: uint40(block.timestamp),
            lastCheckpointAt: uint40(block.timestamp),
            mineableCrystalUnits: version.mineableCrystalUnits,
            maximumPhases: version.maximumPhases,
            phaseXp: version.phaseXp,
            maximumRunXp: version.maximumRunXp,
            maximumWalletXpPerDay: version.maximumWalletXpPerDay,
            maximumMinerXpPerDay: version.maximumMinerXpPerDay,
            checkpointTimeout: version.checkpointTimeout,
            completedPhases: 0,
            minedCrystalUnits: 0,
            carryCapacity: traits.carryCapacity,
            deathRetentionBps: traits.deathRetentionBps,
            failedRunsRetainXp: version.failedRunsRetainXp,
            nonce: authorization.nonce
        });
        miner.setRunLocked(authorization.minerId, true);
        emit EndlessRunStarted(
            runId,
            authorization.player,
            authorization.minerId,
            authorization.versionId,
            authorization.loadoutHash,
            traits.carryCapacity
        );
    }

    function checkpoint(EndlessCheckpoint calldata receipt, bytes calldata rewardSignature)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        _requireSafeRoleSplit();
        if (block.timestamp > receipt.deadline) revert AuthorizationExpired();
        ActiveEndlessRun storage active = _activeRuns[receipt.minerId];
        if (active.runId == bytes32(0)) revert RunNotActive();
        if (
            receipt.runId != active.runId || receipt.player != active.player
                || receipt.versionId != active.versionId || receipt.nonce != active.nonce
                || receipt.previousDigest != active.checkpointDigest
                || miner.ownerOf(receipt.minerId) != receipt.player
        ) revert RunMismatch();
        if (!_validCheckpoint(receipt, rewardSignature)) revert InvalidSignature();
        if (
            receipt.checkpointDigest == bytes32(0)
                || receipt.completedPhases != active.completedPhases + 1
                || receipt.completedPhases > active.maximumPhases
                || receipt.minedCrystalUnits < active.minedCrystalUnits
                || receipt.minedCrystalUnits > active.mineableCrystalUnits
        ) revert InvalidRunResult();
        active.checkpointDigest = receipt.checkpointDigest;
        active.lastCheckpointAt = uint40(block.timestamp);
        active.completedPhases = receipt.completedPhases;
        active.minedCrystalUnits = receipt.minedCrystalUnits;
        emit EndlessCheckpointAccepted(
            receipt.runId,
            receipt.minerId,
            receipt.completedPhases,
            receipt.minedCrystalUnits,
            receipt.checkpointDigest
        );
    }

    function settle(EndlessResult calldata result, bytes calldata rewardSignature)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        _requireSafeRoleSplit();
        if (block.timestamp > result.deadline) revert AuthorizationExpired();
        ActiveEndlessRun memory active = _activeRuns[result.minerId];
        if (active.runId == bytes32(0)) revert RunNotActive();
        if (processedRuns[result.runId]) revert RunAlreadyProcessed();
        if (
            result.runId != active.runId || result.player != active.player
                || result.versionId != active.versionId || result.nonce != active.nonce
                || result.checkpointDigest != active.checkpointDigest
                || result.completedPhases != active.completedPhases
                || result.minedCrystalUnits != active.minedCrystalUnits
                || miner.ownerOf(result.minerId) != result.player
        ) revert RunMismatch();
        if (!_validResult(result, rewardSignature)) revert InvalidSignature();
        if (result.completedPhases == 0 || result.completedPhases > active.maximumPhases) {
            revert InvalidRunResult();
        }
        _settleVerified(result, active);
    }

    function forceAbandon(uint256 minerId) external nonReentrant {
        ActiveEndlessRun memory active = _activeRuns[minerId];
        if (active.runId == bytes32(0)) revert RunNotActive();
        if (miner.ownerOf(minerId) != msg.sender || active.player != msg.sender) revert NotMinerOwner();
        if (block.timestamp < uint256(active.lastCheckpointAt) + active.checkpointTimeout) {
            revert ForceAbandonTooEarly();
        }
        processedRuns[active.runId] = true;
        delete _activeRuns[minerId];
        loadout.applyDeath(minerId);
        miner.setRunLocked(minerId, false);
        emit EndlessRunForceAbandoned(active.runId, active.player, minerId);
    }

    function activeRun(uint256 minerId) external view returns (ActiveEndlessRun memory) {
        return _activeRuns[minerId];
    }

    function setRewardSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (signer == address(0)) revert ZeroAddress();
        rewardSigner = signer;
        emit RewardSignerUpdated(signer);
    }

    function _settleVerified(EndlessResult calldata result, ActiveEndlessRun memory active) private {
        uint256 carriedUnits = Math.min(result.minedCrystalUnits, active.carryCapacity);
        uint256 converted = Math.min(carriedUnits * uint256(active.conversionRate), active.maximumPayout);
        converted = Math.min(converted, HARD_RUN_PAYOUT_TOKENS * crystalUnit);
        uint256 day = block.timestamp / 1 days;
        uint256 dailyRemaining = active.maximumDailyPayout > crystalsBankedByDay[day]
            ? active.maximumDailyPayout - crystalsBankedByDay[day]
            : 0;
        uint256 crystalsBanked = Math.min(converted, dailyRemaining);

        uint256 rawXp = Math.min(
            uint256(result.completedPhases) * uint256(active.phaseXp),
            uint256(active.maximumRunXp)
        );
        uint256 walletRemaining = active.maximumWalletXpPerDay > walletXpByDay[result.player][day]
            ? active.maximumWalletXpPerDay - walletXpByDay[result.player][day]
            : 0;
        uint256 minerRemaining = active.maximumMinerXpPerDay > minerXpByDay[result.minerId][day]
            ? active.maximumMinerXpPerDay - minerXpByDay[result.minerId][day]
            : 0;
        uint256 xpBanked = Math.min(rawXp, Math.min(walletRemaining, minerRemaining));
        bool retainXp = result.outcome == MattV2Types.Outcome.Extraction || active.failedRunsRetainXp;
        if (!retainXp) xpBanked = 0;

        processedRuns[result.runId] = true;
        delete _activeRuns[result.minerId];
        uint8 oldLevel = miner.traitsOf(result.minerId).level;
        if (result.outcome == MattV2Types.Outcome.Extraction) {
            if (xpBanked != 0) miner.applyXp(result.minerId, xpBanked);
        } else {
            crystalsBanked = Math.mulDiv(crystalsBanked, active.deathRetentionBps, 10_000);
            if (xpBanked != 0) miner.applyXp(result.minerId, xpBanked);
            loadout.applyDeath(result.minerId);
        }
        walletXpByDay[result.player][day] += uint32(xpBanked);
        minerXpByDay[result.minerId][day] += uint32(xpBanked);
        crystalsBankedByDay[day] += crystalsBanked;

        uint40 playedAt = uint40(block.timestamp);
        (uint40 previousActiveUntil, uint40 newActiveUntil) = miner.recordVerifiedPlay(result.minerId, playedAt);
        passiveRewards.recordActivity(result.minerId, playedAt, previousActiveUntil, newActiveUntil);
        uint8 newLevel = miner.traitsOf(result.minerId).level;
        if (oldLevel < 100 && newLevel == 100) passiveRewards.queueLevel100(result.minerId);
        if (crystalsBanked != 0) crystalBank.credit(result.player, crystalsBanked, result.runId);
        miner.setRunLocked(result.minerId, false);

        emit EndlessRunSettled(
            result.runId,
            result.player,
            result.minerId,
            result.outcome,
            result.completedPhases,
            result.minedCrystalUnits,
            xpBanked,
            crystalsBanked,
            result.checkpointDigest
        );
    }

    function _validAuthorization(EndlessRunAuthorization calldata value, bytes calldata signature)
        private
        view
        returns (bool)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                RUN_AUTHORIZATION_TYPEHASH,
                value.player,
                value.minerId,
                value.versionId,
                value.loadoutHash,
                value.nonce,
                value.deadline
            )
        );
        return SignatureCheckerCompat.isValidSignatureNow(
            value.player, _hashTypedDataV4(structHash), signature
        );
    }

    function _validCheckpoint(EndlessCheckpoint calldata value, bytes calldata signature)
        private
        view
        returns (bool)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                CHECKPOINT_TYPEHASH,
                value.player,
                value.minerId,
                value.runId,
                value.versionId,
                value.previousDigest,
                value.checkpointDigest,
                value.completedPhases,
                value.minedCrystalUnits,
                value.nonce,
                value.deadline
            )
        );
        return SignatureCheckerCompat.isValidSignatureNow(rewardSigner, _hashTypedDataV4(structHash), signature);
    }

    function _validResult(EndlessResult calldata value, bytes calldata signature)
        private
        view
        returns (bool)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                RESULT_TYPEHASH,
                value.player,
                value.minerId,
                value.runId,
                value.versionId,
                value.checkpointDigest,
                value.outcome,
                value.completedPhases,
                value.minedCrystalUnits,
                value.nonce,
                value.deadline
            )
        );
        return SignatureCheckerCompat.isValidSignatureNow(rewardSigner, _hashTypedDataV4(structHash), signature);
    }

    function _requireSafeRoleSplit() private view {
        if (rewardSigner == address(0) || hasRole(OPERATOR_ROLE, rewardSigner)) revert UnsafeRoleOverlap();
    }

    function _validateUnpause() internal view override {
        _requireSafeRoleSplit();
    }

    uint256[40] private __gap;
}
