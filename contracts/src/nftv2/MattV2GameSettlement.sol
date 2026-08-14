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
import {MattV2Math} from "./libraries/MattV2Math.sol";
import {MattV2Types} from "./libraries/MattV2Types.sol";

/// @title MATT Mine Game Settlement V2
/// @notice Player-authorized starts and independently signed, server-submitted run settlement.
contract MattV2GameSettlement is MattV2UpgradeableModule, EIP712Upgradeable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    uint256 public constant HARD_RUN_PAYOUT_TOKENS = 100_000;
    uint256 public constant HARD_CONVERSION_TOKENS = 100_000;
    uint32 public constant MIN_RUN_TIMEOUT = 5 minutes;
    uint32 public constant MAX_RUN_TIMEOUT = 24 hours;

    bytes32 public constant RUN_AUTHORIZATION_TYPEHASH = keccak256(
        "RunAuthorization(address player,uint256 minerId,bytes32 mapVersion,bytes32 loadoutHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant RUN_RESULT_TYPEHASH = keccak256(
        "RunResult(address player,uint256 minerId,bytes32 runId,bytes32 mapVersion,bytes32 loadoutHash,uint8 outcome,uint8 completedPhases,uint32 minedCrystalUnits,uint256 nonce,uint256 deadline)"
    );

    struct RunAuthorization {
        address player;
        uint256 minerId;
        bytes32 mapVersion;
        bytes32 loadoutHash;
        uint256 nonce;
        uint256 deadline;
    }

    struct RunResult {
        address player;
        uint256 minerId;
        bytes32 runId;
        bytes32 mapVersion;
        bytes32 loadoutHash;
        MattV2Types.Outcome outcome;
        uint8 completedPhases;
        uint32 minedCrystalUnits;
        uint256 nonce;
        uint256 deadline;
    }

    struct MapVersion {
        bytes32 mapId;
        bytes32 contentHash;
        uint128 conversionRate;
        uint128 maximumPayout;
        uint32 mineableCrystalUnits;
        uint32 runTimeout;
        bool approved;
        bool retired;
    }

    struct ActiveRun {
        bytes32 runId;
        bytes32 mapVersion;
        bytes32 loadoutHash;
        address player;
        uint128 conversionRate;
        uint128 maximumPayout;
        uint40 startedAt;
        uint32 mineableCrystalUnits;
        uint32 runTimeout;
        uint16 carryCapacity;
        uint16 deathRetentionBps;
        uint256 nonce;
    }

    MattV2Miner public miner;
    MattV2Loadout public loadout;
    IMattV2CrystalBank public crystalBank;
    IMattV2PassiveRewards public passiveRewards;
    address public rewardSigner;
    uint256 public crystalUnit;

    mapping(bytes32 versionId => MapVersion version) public mapVersions;
    mapping(uint256 minerId => ActiveRun run) private _activeRuns;
    mapping(address player => uint256 nonce) public playerNonces;
    mapping(bytes32 runId => bool processed) public processedRuns;

    event MapVersionApproved(
        bytes32 indexed versionId,
        bytes32 indexed mapId,
        bytes32 indexed contentHash,
        uint32 mineableCrystalUnits,
        uint256 conversionRate,
        uint256 maximumPayout,
        uint32 runTimeout
    );
    event MapVersionRetired(bytes32 indexed versionId);
    event RunStarted(
        bytes32 indexed runId,
        address indexed player,
        uint256 indexed minerId,
        bytes32 mapVersion,
        bytes32 loadoutHash,
        uint16 carryCapacity,
        uint16 deathRetentionBps,
        uint40 startedAt
    );
    event RunSettled(
        bytes32 indexed runId,
        address indexed player,
        uint256 indexed minerId,
        MattV2Types.Outcome outcome,
        uint8 completedPhases,
        uint32 minedCrystalUnits,
        uint256 xpBanked,
        uint256 crystalsBanked
    );
    event RunForceAbandoned(bytes32 indexed runId, address indexed player, uint256 indexed minerId);
    event RewardSignerUpdated(address indexed signer);

    error InvalidConfiguration();
    error InvalidMapVersion();
    error MapVersionAlreadyExists();
    error MapUnavailable();
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
        __EIP712_init("MATT Mine V2 Run Settlement", "2");
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

    function approveMapVersion(
        bytes32 mapId,
        bytes32 contentHash,
        uint32 mineableCrystalUnits,
        uint256 conversionRate,
        uint256 maximumPayout,
        uint32 runTimeout
    ) external onlyRole(CONFIG_ROLE) returns (bytes32 versionId) {
        uint256 unit = crystalUnit;
        if (
            mapId == bytes32(0) || contentHash == bytes32(0) || mineableCrystalUnits == 0
                || conversionRate == 0 || conversionRate > HARD_CONVERSION_TOKENS * unit
                || maximumPayout == 0 || maximumPayout > HARD_RUN_PAYOUT_TOKENS * unit
                || runTimeout < MIN_RUN_TIMEOUT || runTimeout > MAX_RUN_TIMEOUT
                || conversionRate > type(uint128).max || maximumPayout > type(uint128).max
        ) revert InvalidConfiguration();
        versionId = keccak256(
            abi.encode(mapId, contentHash, mineableCrystalUnits, conversionRate, maximumPayout, runTimeout)
        );
        if (mapVersions[versionId].approved) revert MapVersionAlreadyExists();
        mapVersions[versionId] = MapVersion({
            mapId: mapId,
            contentHash: contentHash,
            conversionRate: uint128(conversionRate),
            maximumPayout: uint128(maximumPayout),
            mineableCrystalUnits: mineableCrystalUnits,
            runTimeout: runTimeout,
            approved: true,
            retired: false
        });
        emit MapVersionApproved(
            versionId,
            mapId,
            contentHash,
            mineableCrystalUnits,
            conversionRate,
            maximumPayout,
            runTimeout
        );
    }

    function retireMapVersion(bytes32 versionId) external onlyRole(CONFIG_ROLE) {
        MapVersion storage version = mapVersions[versionId];
        if (!version.approved || version.retired) revert InvalidMapVersion();
        version.retired = true;
        emit MapVersionRetired(versionId);
    }

    function beginRun(RunAuthorization calldata authorization, bytes calldata playerSignature)
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
        MapVersion memory version = mapVersions[authorization.mapVersion];
        if (!version.approved || version.retired) revert MapUnavailable();
        bytes32 currentLoadoutHash = loadout.loadoutHash(authorization.minerId);
        if (currentLoadoutHash != authorization.loadoutHash) revert RunMismatch();
        if (!_validPlayerAuthorization(authorization, playerSignature)) revert InvalidSignature();

        MattV2Loadout.EffectiveTraits memory traits = loadout.effectiveTraits(authorization.minerId);
        runId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                authorization.player,
                authorization.minerId,
                authorization.mapVersion,
                authorization.nonce
            )
        );
        if (processedRuns[runId]) revert RunAlreadyProcessed();
        playerNonces[authorization.player] = authorization.nonce + 1;
        _activeRuns[authorization.minerId] = ActiveRun({
            runId: runId,
            mapVersion: authorization.mapVersion,
            loadoutHash: authorization.loadoutHash,
            player: authorization.player,
            conversionRate: version.conversionRate,
            maximumPayout: version.maximumPayout,
            startedAt: uint40(block.timestamp),
            mineableCrystalUnits: version.mineableCrystalUnits,
            runTimeout: version.runTimeout,
            carryCapacity: traits.carryCapacity,
            deathRetentionBps: traits.deathRetentionBps,
            nonce: authorization.nonce
        });
        miner.setRunLocked(authorization.minerId, true);
        emit RunStarted(
            runId,
            authorization.player,
            authorization.minerId,
            authorization.mapVersion,
            authorization.loadoutHash,
            traits.carryCapacity,
            traits.deathRetentionBps,
            uint40(block.timestamp)
        );
    }

    function settleRun(RunResult calldata result, bytes calldata rewardSignature)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        _requireSafeRoleSplit();
        if (block.timestamp > result.deadline) revert AuthorizationExpired();
        ActiveRun memory active = _activeRuns[result.minerId];
        if (active.runId == bytes32(0)) revert RunNotActive();
        if (processedRuns[result.runId]) revert RunAlreadyProcessed();
        if (
            result.runId != active.runId || result.player != active.player || result.mapVersion != active.mapVersion
                || result.loadoutHash != active.loadoutHash || result.nonce != active.nonce
                || miner.ownerOf(result.minerId) != result.player
        ) revert RunMismatch();
        if (!_validRewardResult(result, rewardSignature)) revert InvalidSignature();
        if (result.completedPhases > 5 || result.minedCrystalUnits > active.mineableCrystalUnits) {
            revert InvalidRunResult();
        }
        if (result.outcome == MattV2Types.Outcome.Extraction && result.completedPhases == 0) {
            revert InvalidRunResult();
        }

        uint256 carriedUnits = Math.min(result.minedCrystalUnits, active.carryCapacity);
        uint256 converted = carriedUnits * uint256(active.conversionRate);
        converted = Math.min(converted, active.maximumPayout);
        converted = Math.min(converted, HARD_RUN_PAYOUT_TOKENS * crystalUnit);

        uint256 xpBanked;
        uint256 crystalsBanked;
        processedRuns[result.runId] = true;
        delete _activeRuns[result.minerId];

        uint8 oldLevel = miner.traitsOf(result.minerId).level;
        if (result.outcome == MattV2Types.Outcome.Extraction) {
            xpBanked = MattV2Math.xpForPhases(result.completedPhases);
            crystalsBanked = converted;
            miner.applyXp(result.minerId, xpBanked);
        } else {
            crystalsBanked = Math.mulDiv(converted, active.deathRetentionBps, 10_000);
            loadout.applyDeath(result.minerId);
        }

        uint40 playedAt = uint40(block.timestamp);
        (uint40 previousActiveUntil, uint40 newActiveUntil) = miner.recordVerifiedPlay(result.minerId, playedAt);
        passiveRewards.recordActivity(result.minerId, playedAt, previousActiveUntil, newActiveUntil);
        uint8 newLevel = miner.traitsOf(result.minerId).level;
        if (oldLevel < 100 && newLevel == 100) passiveRewards.queueLevel100(result.minerId);
        if (crystalsBanked != 0) crystalBank.credit(result.player, crystalsBanked, result.runId);
        miner.setRunLocked(result.minerId, false);

        emit RunSettled(
            result.runId,
            result.player,
            result.minerId,
            result.outcome,
            result.completedPhases,
            result.minedCrystalUnits,
            xpBanked,
            crystalsBanked
        );
    }

    function forceAbandon(uint256 minerId) external nonReentrant {
        ActiveRun memory active = _activeRuns[minerId];
        if (active.runId == bytes32(0)) revert RunNotActive();
        if (miner.ownerOf(minerId) != msg.sender || active.player != msg.sender) revert NotMinerOwner();
        if (block.timestamp < uint256(active.startedAt) + active.runTimeout) revert ForceAbandonTooEarly();
        processedRuns[active.runId] = true;
        delete _activeRuns[minerId];
        loadout.applyDeath(minerId);
        miner.setRunLocked(minerId, false);
        emit RunForceAbandoned(active.runId, active.player, minerId);
    }

    function activeRun(uint256 minerId) external view returns (ActiveRun memory) {
        return _activeRuns[minerId];
    }

    function setRewardSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (signer == address(0)) revert ZeroAddress();
        rewardSigner = signer;
        emit RewardSignerUpdated(signer);
    }

    function _validPlayerAuthorization(RunAuthorization calldata authorization, bytes calldata signature)
        private
        view
        returns (bool)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                RUN_AUTHORIZATION_TYPEHASH,
                authorization.player,
                authorization.minerId,
                authorization.mapVersion,
                authorization.loadoutHash,
                authorization.nonce,
                authorization.deadline
            )
        );
        return SignatureCheckerCompat.isValidSignatureNow(
            authorization.player, _hashTypedDataV4(structHash), signature
        );
    }

    function _validRewardResult(RunResult calldata result, bytes calldata signature)
        private
        view
        returns (bool)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                RUN_RESULT_TYPEHASH,
                result.player,
                result.minerId,
                result.runId,
                result.mapVersion,
                result.loadoutHash,
                result.outcome,
                result.completedPhases,
                result.minedCrystalUnits,
                result.nonce,
                result.deadline
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

    uint256[34] private __gap;
}
