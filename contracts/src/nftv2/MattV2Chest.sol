// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MattV2UpgradeableModule} from "./base/MattV2UpgradeableModule.sol";
import {MattV2Equipment} from "./MattV2Equipment.sol";
import {MattV2Math} from "./libraries/MattV2Math.sol";
import {MattV2Types} from "./libraries/MattV2Types.sol";
import {IRandomnessProvider} from "../nft/interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../nft/interfaces/IRandomnessConsumer.sol";
import {IRandomnessStatus} from "../nft/interfaces/IRandomnessStatus.sol";
import {IRandomnessCancellation} from "../nft/interfaces/IRandomnessCancellation.sol";

/// @title MATT Mine Chest V2
/// @notice Six slot-specific, VRF-randomized Equipment chests with escrowed MATT.
contract MattV2Chest is MattV2UpgradeableModule, IRandomnessConsumer {
    using SafeERC20 for IERC20;

    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    uint256 public constant REQUEST_TIMEOUT = 24 hours;
    uint8 public constant MAX_CHESTS_PER_PURCHASE = 10;

    struct PendingRequest {
        address buyer;
        uint128 price;
        uint40 requestedAt;
        uint32 definitionVersion;
        MattV2Types.Slot slot;
    }

    IERC20 public matt;
    MattV2Equipment public equipment;
    IRandomnessProvider public randomnessProvider;
    address public treasury;
    uint32 public activeDefinitionVersion;

    mapping(MattV2Types.Slot slot => uint256 price) public chestPrice;
    mapping(bytes32 requestKey => PendingRequest request) public pendingRequests;
    mapping(uint32 version => mapping(uint8 slot => mapping(uint8 rarity => uint32[] definitionIds)))
        private _definitionPools;
    mapping(uint32 version => mapping(uint8 slot => mapping(uint8 rarity => bool configured)))
        private _poolConfigured;
    mapping(uint32 version => bool frozen) public definitionVersionFrozen;

    event ChestRequested(
        bytes32 indexed requestKey,
        address indexed provider,
        uint256 indexed providerRequestId,
        address buyer,
        MattV2Types.Slot slot,
        uint32 definitionVersion,
        uint256 price
    );
    event ChestFulfilled(
        bytes32 indexed requestKey,
        address indexed buyer,
        uint256 indexed equipmentTokenId,
        MattV2Types.Slot slot,
        MattV2Types.Rarity rarity,
        uint32 definitionId
    );
    event ChestRefunded(bytes32 indexed requestKey, address indexed buyer, uint256 refund);
    event ChestPriceUpdated(MattV2Types.Slot indexed slot, uint256 price);
    event DefinitionPoolConfigured(
        uint32 indexed version,
        MattV2Types.Slot indexed slot,
        MattV2Types.Rarity indexed rarity,
        uint32[] definitionIds
    );
    event DefinitionVersionActivated(uint32 indexed version);
    event RandomnessProviderUpdated(address indexed provider);
    event TreasuryUpdated(address indexed treasury);

    error InvalidConfiguration();
    error PriceTooLarge();
    error UnknownRequest();
    error RequestAlreadyExists();
    error RequestNotExpired();
    error NotRequestBuyer();
    error EmptyDefinitionPool();
    error IncompleteDefinitionVersion();
    error DefinitionVersionIsFrozen();
    error RandomnessAlreadyFulfilled();
    error InvalidQuantity();

    constructor(address upgradeTimelock) MattV2UpgradeableModule(upgradeTimelock) {}

    function initialize(
        address admin,
        address pauser,
        address configOperator,
        IERC20 matt_,
        MattV2Equipment equipment_,
        IRandomnessProvider randomnessProvider_,
        address treasury_
    ) external initializer {
        __MattV2UpgradeableModule_init(admin, pauser);
        if (
            configOperator == address(0) || address(matt_) == address(0) || address(equipment_) == address(0)
                || address(randomnessProvider_) == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (address(matt_).code.length == 0 || address(equipment_).code.length == 0) {
            revert InvalidConfiguration();
        }
        _validateRandomnessProvider(randomnessProvider_);
        matt = matt_;
        equipment = equipment_;
        randomnessProvider = randomnessProvider_;
        treasury = treasury_;
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(CONFIG_ROLE, configOperator);
    }

    function openChest(MattV2Types.Slot slot)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 requestKey)
    {
        (uint256 price, uint32 version) = _chestTerms(slot);
        matt.safeTransferFrom(msg.sender, address(this), price);
        requestKey = _requestChest(msg.sender, slot, price, version);
    }

    function openChests(MattV2Types.Slot slot, uint8 quantity)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32[] memory requestKeys)
    {
        if (quantity == 0 || quantity > MAX_CHESTS_PER_PURCHASE) revert InvalidQuantity();
        (uint256 price, uint32 version) = _chestTerms(slot);
        matt.safeTransferFrom(msg.sender, address(this), price * quantity);
        requestKeys = new bytes32[](quantity);
        for (uint256 index; index < quantity; ++index) {
            requestKeys[index] = _requestChest(msg.sender, slot, price, version);
        }
    }

    function _chestTerms(MattV2Types.Slot slot) private view returns (uint256 price, uint32 version) {
        price = chestPrice[slot];
        version = activeDefinitionVersion;
        if (price == 0 || version == 0) revert InvalidConfiguration();
        if (price > type(uint128).max) revert PriceTooLarge();
    }

    function _requestChest(address buyer, MattV2Types.Slot slot, uint256 price, uint32 version)
        private
        returns (bytes32 requestKey)
    {
        address provider = address(randomnessProvider);
        uint256 providerRequestId = randomnessProvider.requestRandomWord();
        requestKey = keccak256(abi.encode(provider, providerRequestId));
        if (providerRequestId == 0 || pendingRequests[requestKey].buyer != address(0)) {
            revert RequestAlreadyExists();
        }
        pendingRequests[requestKey] = PendingRequest({
            buyer: buyer,
            price: uint128(price),
            requestedAt: uint40(block.timestamp),
            definitionVersion: version,
            slot: slot
        });
        emit ChestRequested(requestKey, provider, providerRequestId, buyer, slot, version, price);
    }

    function fulfillRandomness(uint256 providerRequestId, uint256 randomWord)
        external
        override
        nonReentrant
    {
        bytes32 requestKey = keccak256(abi.encode(msg.sender, providerRequestId));
        PendingRequest memory request = pendingRequests[requestKey];
        if (request.buyer == address(0)) revert UnknownRequest();
        MattV2Types.Rarity rarity = MattV2Math.rollRarity(randomWord);
        uint32[] storage pool = _definitionPools[request.definitionVersion][uint8(request.slot)][uint8(rarity)];
        if (pool.length == 0) revert EmptyDefinitionPool();
        uint32 definitionId = pool[
            uint256(keccak256(abi.encode(randomWord, requestKey, request.definitionVersion))) % pool.length
        ];

        delete pendingRequests[requestKey];
        uint256 tokenId = equipment.mintEquipment(request.buyer, request.slot, rarity, definitionId);
        matt.safeTransfer(treasury, request.price);
        emit ChestFulfilled(requestKey, request.buyer, tokenId, request.slot, rarity, definitionId);
    }

    function refundExpiredRequest(address provider, uint256 providerRequestId) external nonReentrant {
        bytes32 requestKey = keccak256(abi.encode(provider, providerRequestId));
        PendingRequest memory request = pendingRequests[requestKey];
        if (request.buyer == address(0)) revert UnknownRequest();
        if (request.buyer != msg.sender) revert NotRequestBuyer();
        if (block.timestamp < uint256(request.requestedAt) + REQUEST_TIMEOUT) revert RequestNotExpired();
        if (IRandomnessStatus(provider).isRequestFulfilled(providerRequestId)) {
            revert RandomnessAlreadyFulfilled();
        }
        IRandomnessCancellation(provider).cancelRequest(providerRequestId);
        delete pendingRequests[requestKey];
        matt.safeTransfer(request.buyer, request.price);
        emit ChestRefunded(requestKey, request.buyer, request.price);
    }

    function setChestPrice(MattV2Types.Slot slot, uint256 price) external onlyRole(CONFIG_ROLE) {
        if (price == 0 || price > type(uint128).max) revert InvalidConfiguration();
        chestPrice[slot] = price;
        emit ChestPriceUpdated(slot, price);
    }

    function configureDefinitionPool(
        uint32 version,
        MattV2Types.Slot slot,
        MattV2Types.Rarity rarity,
        uint32[] calldata definitionIds
    ) external onlyRole(CONFIG_ROLE) whenPaused {
        if (version == 0 || definitionIds.length == 0) revert InvalidConfiguration();
        if (definitionVersionFrozen[version]) revert DefinitionVersionIsFrozen();
        _definitionPools[version][uint8(slot)][uint8(rarity)] = definitionIds;
        _poolConfigured[version][uint8(slot)][uint8(rarity)] = true;
        emit DefinitionPoolConfigured(version, slot, rarity, definitionIds);
    }

    function activateDefinitionVersion(uint32 version) external onlyRole(CONFIG_ROLE) whenPaused {
        if (version == 0) revert InvalidConfiguration();
        for (uint8 slot; slot < 6; ++slot) {
            for (uint8 rarity; rarity < 5; ++rarity) {
                if (!_poolConfigured[version][slot][rarity]) revert IncompleteDefinitionVersion();
            }
        }
        definitionVersionFrozen[version] = true;
        activeDefinitionVersion = version;
        emit DefinitionVersionActivated(version);
    }

    function definitionPool(uint32 version, MattV2Types.Slot slot, MattV2Types.Rarity rarity)
        external
        view
        returns (uint32[] memory)
    {
        return _definitionPools[version][uint8(slot)][uint8(rarity)];
    }

    function setRandomnessProvider(IRandomnessProvider provider) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        _validateRandomnessProvider(provider);
        randomnessProvider = provider;
        emit RandomnessProviderUpdated(address(provider));
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function _validateRandomnessProvider(IRandomnessProvider provider) private view {
        address providerAddress = address(provider);
        if (providerAddress == address(0)) revert ZeroAddress();
        if (providerAddress.code.length == 0) revert InvalidConfiguration();
        try IRandomnessStatus(providerAddress).isRequestFulfilled(0) returns (bool) {}
        catch {
            revert InvalidConfiguration();
        }
        try IRandomnessCancellation(providerAddress).supportsRequestCancellation() returns (bool supported) {
            if (!supported) revert InvalidConfiguration();
        } catch {
            revert InvalidConfiguration();
        }
    }

    uint256[38] private __gap;
}
