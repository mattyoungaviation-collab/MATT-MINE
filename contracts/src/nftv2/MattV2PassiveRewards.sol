// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IMattCrystal} from "../nft/interfaces/IMattCrystal.sol";
import {IRandomnessProvider} from "../nft/interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../nft/interfaces/IRandomnessConsumer.sol";
import {MattV2UpgradeableModule} from "./base/MattV2UpgradeableModule.sol";
import {MattV2Miner} from "./MattV2Miner.sol";
import {MattV2Math} from "./libraries/MattV2Math.sol";

/// @title MATT Mine Passive Rewards V2
/// @notice Permanent Level-100 CPH assignment and midnight-owner payouts.
contract MattV2PassiveRewards is MattV2UpgradeableModule, IRandomnessConsumer {
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 public constant PUBLIC_CATCHUP_DELAY = 1 hours;
    uint256 public constant MAX_BATCH = 100;

    struct ActivityInterval {
        uint40 start;
        uint40 end;
    }

    struct RateRequest {
        bytes32 requestKey;
        bool queued;
        bool requested;
    }

    MattV2Miner public miner;
    IMattCrystal public crystal;
    IRandomnessProvider public randomnessProvider;
    uint256 public tokenUnit;

    mapping(uint256 minerId => ActivityInterval[]) private _activityIntervals;
    mapping(uint256 minerId => RateRequest request) public rateRequests;
    mapping(bytes32 requestKey => uint256 minerId) public requestMiner;
    mapping(uint256 utcDay => mapping(uint256 minerId => bool paid)) public payoutProcessed;

    event PassiveRateQueued(uint256 indexed minerId);
    event PassiveRateRequested(
        uint256 indexed minerId,
        bytes32 indexed requestKey,
        address indexed provider,
        uint256 providerRequestId
    );
    event PassiveRateRequestDeferred(uint256 indexed minerId);
    event PassiveRateFulfilled(uint256 indexed minerId, uint8 crystalsPerHour, uint40 assignedAt);
    event ActivityIntervalUpdated(uint256 indexed minerId, uint40 start, uint40 end);
    event PassivePayout(
        uint256 indexed minerId,
        uint256 indexed utcDay,
        address indexed recipient,
        uint256 eligibleSeconds,
        uint256 amount
    );
    event RandomnessProviderUpdated(address indexed provider);

    error InvalidToken();
    error InvalidMinerState();
    error UnknownRequest();
    error RateAlreadyRequested();
    error InvalidActivityWindow();
    error InvalidBatch();
    error PayoutTooEarly();
    error InvalidDependency();

    constructor(address upgradeTimelock) MattV2UpgradeableModule(upgradeTimelock) {}

    function initialize(
        address admin,
        address pauser,
        address settlement,
        address keeper,
        MattV2Miner miner_,
        IMattCrystal crystal_,
        IRandomnessProvider randomnessProvider_
    ) external initializer {
        __MattV2UpgradeableModule_init(admin, pauser);
        if (
            settlement == address(0) || keeper == address(0) || address(miner_) == address(0)
                || address(crystal_) == address(0) || address(randomnessProvider_) == address(0)
        ) revert ZeroAddress();
        if (
            address(miner_).code.length == 0 || address(crystal_).code.length == 0
                || address(randomnessProvider_).code.length == 0
        ) revert InvalidDependency();
        uint8 decimals = IERC20Metadata(address(crystal_)).decimals();
        if (decimals > 18) revert InvalidToken();
        miner = miner_;
        crystal = crystal_;
        randomnessProvider = randomnessProvider_;
        tokenUnit = 10 ** decimals;
        _grantRole(SETTLEMENT_ROLE, admin);
        _grantRole(SETTLEMENT_ROLE, settlement);
        _grantRole(KEEPER_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
    }

    function queueLevel100(uint256 minerId) external onlyRole(SETTLEMENT_ROLE) whenNotPaused {
        MattV2Miner.MinerTraits memory traits = miner.traitsOf(minerId);
        if (traits.level != 100) revert InvalidMinerState();
        RateRequest storage request = rateRequests[minerId];
        if (traits.crystalsPerHour != 0 || request.queued) return;
        request.queued = true;
        emit PassiveRateQueued(minerId);
        _tryRequestRate(minerId, request);
    }

    function requestQueuedRate(uint256 minerId) external whenNotPaused returns (bool requested) {
        RateRequest storage request = rateRequests[minerId];
        if (!request.queued) revert InvalidMinerState();
        if (request.requested) revert RateAlreadyRequested();
        requested = _tryRequestRate(minerId, request);
    }

    function fulfillRandomness(uint256 providerRequestId, uint256 randomWord) external override nonReentrant {
        bytes32 requestKey = keccak256(abi.encode(msg.sender, providerRequestId));
        uint256 minerId = requestMiner[requestKey];
        if (minerId == 0) revert UnknownRequest();
        delete requestMiner[requestKey];
        delete rateRequests[minerId];
        uint8 rate = MattV2Math.rollCrystalsPerHour(randomWord);
        uint40 assignedAt = uint40(block.timestamp);
        miner.assignPassiveRate(minerId, rate, assignedAt);
        emit PassiveRateFulfilled(minerId, rate, assignedAt);
    }

    function recordActivity(uint256 minerId, uint40 playedAt, uint40 previousActiveUntil, uint40 newActiveUntil)
        external
        onlyRole(SETTLEMENT_ROLE)
    {
        if (playedAt == 0 || newActiveUntil <= playedAt || newActiveUntil < previousActiveUntil) {
            revert InvalidActivityWindow();
        }
        ActivityInterval[] storage intervals = _activityIntervals[minerId];
        uint256 length = intervals.length;
        if (length == 0 || playedAt > intervals[length - 1].end) {
            intervals.push(ActivityInterval({start: playedAt, end: newActiveUntil}));
            emit ActivityIntervalUpdated(minerId, playedAt, newActiveUntil);
        } else if (newActiveUntil > intervals[length - 1].end) {
            intervals[length - 1].end = newActiveUntil;
            emit ActivityIntervalUpdated(minerId, intervals[length - 1].start, newActiveUntil);
        }
    }

    /// @param utcDay Day number whose boundary pays the preceding UTC day.
    function processPayouts(uint256 utcDay, uint256[] calldata minerIds) external nonReentrant whenNotPaused {
        uint256 boundary = utcDay * 1 days;
        if (utcDay == 0 || block.timestamp < boundary) revert PayoutTooEarly();
        if (!hasRole(KEEPER_ROLE, msg.sender) && block.timestamp < boundary + PUBLIC_CATCHUP_DELAY) {
            revert PayoutTooEarly();
        }
        if (minerIds.length == 0 || minerIds.length > MAX_BATCH) revert InvalidBatch();
        for (uint256 i; i < minerIds.length; ++i) _processOne(utcDay, boundary, minerIds[i]);
    }

    function eligibleSeconds(uint256 minerId, uint256 periodStart, uint256 periodEnd)
        public
        view
        returns (uint256)
    {
        if (periodEnd <= periodStart) return 0;
        ActivityInterval[] storage intervals = _activityIntervals[minerId];
        uint256 low;
        uint256 high = intervals.length;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            if (intervals[middle].end <= periodStart) low = middle + 1;
            else high = middle;
        }
        uint256 total;
        uint256 length = intervals.length;
        while (low < length && intervals[low].start < periodEnd) {
            uint256 start = intervals[low].start > periodStart ? intervals[low].start : periodStart;
            uint256 end = intervals[low].end < periodEnd ? intervals[low].end : periodEnd;
            if (end > start) total += end - start;
            ++low;
        }
        return total;
    }

    function activityIntervals(uint256 minerId) external view returns (ActivityInterval[] memory) {
        return _activityIntervals[minerId];
    }

    function setRandomnessProvider(IRandomnessProvider provider) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (address(provider) == address(0)) revert ZeroAddress();
        if (address(provider).code.length == 0) revert InvalidDependency();
        randomnessProvider = provider;
        emit RandomnessProviderUpdated(address(provider));
    }

    function _tryRequestRate(uint256 minerId, RateRequest storage request) private returns (bool requested) {
        address provider = address(randomnessProvider);
        try randomnessProvider.requestRandomWord() returns (uint256 providerRequestId) {
            if (providerRequestId == 0) {
                emit PassiveRateRequestDeferred(minerId);
                return false;
            }
            bytes32 requestKey = keccak256(abi.encode(provider, providerRequestId));
            if (requestMiner[requestKey] != 0) revert RateAlreadyRequested();
            request.requested = true;
            request.requestKey = requestKey;
            requestMiner[requestKey] = minerId;
            emit PassiveRateRequested(minerId, requestKey, provider, providerRequestId);
            return true;
        } catch {
            emit PassiveRateRequestDeferred(minerId);
            return false;
        }
    }

    function _processOne(uint256 utcDay, uint256 boundary, uint256 minerId) private {
        if (payoutProcessed[utcDay][minerId]) return;
        MattV2Miner.MinerTraits memory traits = miner.traitsOf(minerId);
        if (traits.crystalsPerHour == 0 || traits.cphAssignedAt >= boundary) return;

        uint256 periodStart = boundary - 1 days;
        if (traits.cphAssignedAt > periodStart) periodStart = traits.cphAssignedAt;
        uint256 secondsEligible = eligibleSeconds(minerId, periodStart, boundary);
        payoutProcessed[utcDay][minerId] = true;
        address recipient = miner.ownerAt(minerId, uint48(boundary));
        uint256 amount = (uint256(traits.crystalsPerHour) * secondsEligible * tokenUnit) / 1 hours;
        if (recipient != address(0) && amount != 0) crystal.mint(recipient, amount);
        emit PassivePayout(minerId, utcDay, recipient, secondsEligible, amount);
    }

    uint256[36] private __gap;
}
