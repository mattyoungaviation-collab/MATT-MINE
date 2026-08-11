// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MattEquipment} from "./MattEquipment.sol";
import {IRandomnessProvider} from "./interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "./interfaces/IRandomnessConsumer.sol";

/// @title MATT Mine Chests
/// @notice Escrows MATT until verifiable randomness fulfills a chest request.
contract MattChest is AccessControlDefaultAdminRules, IRandomnessConsumer, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum ChestType {
        Weapon,
        Helmet,
        ArmorCommon,
        ArmorRare,
        ArmorMythic
    }

    struct PendingRequest {
        address buyer;
        uint96 price;
        uint40 requestedAt;
        ChestType chestType;
    }

    IERC20 public immutable matt;
    MattEquipment public immutable equipment;
    IRandomnessProvider public randomnessProvider;
    address public vault;
    uint256 public requestTimeout = 1 days;
    uint256 public backpackPrice;
    uint32 public backpackDefinitionId;

    mapping(ChestType chestType => uint256 price) public chestPrice;
    mapping(bytes32 requestKey => PendingRequest request) public pendingRequests;
    mapping(MattEquipment.ItemType itemType => mapping(MattEquipment.Rarity rarity => uint32[] definitionIds))
        private _definitionPools;

    event ChestRequested(
        bytes32 indexed requestKey,
        address indexed provider,
        uint256 indexed providerRequestId,
        address buyer,
        ChestType chestType,
        uint256 price
    );
    event ChestFulfilled(
        bytes32 indexed requestKey,
        address indexed buyer,
        uint256 indexed equipmentTokenId,
        MattEquipment.Rarity rarity,
        uint32 definitionId
    );
    event ChestCancelled(bytes32 indexed requestKey, address indexed buyer, uint256 refund);
    event BackpackPurchased(address indexed buyer, uint256 indexed equipmentTokenId, uint256 price);
    event PriceUpdated(ChestType indexed chestType, uint256 price);
    event BackpackConfigurationUpdated(uint256 price, uint32 definitionId);
    event DefinitionPoolUpdated(MattEquipment.ItemType indexed itemType, MattEquipment.Rarity indexed rarity);
    event RandomnessConfigurationUpdated(address indexed provider, uint256 requestTimeout);
    event VaultUpdated(address indexed vault);

    error ZeroAddress();
    error PriceTooLarge();
    error UnknownRequest();
    error RequestAlreadyExists();
    error RequestNotExpired();
    error NotRequestBuyer();
    error EmptyDefinitionPool();

    constructor(
        address admin_,
        IERC20 matt_,
        MattEquipment equipment_,
        IRandomnessProvider randomnessProvider_,
        address vault_,
        address pauser_
    ) AccessControlDefaultAdminRules(1 days, admin_) {
        if (
            address(matt_) == address(0) || address(equipment_) == address(0)
                || address(randomnessProvider_) == address(0) || vault_ == address(0)
                || pauser_ == address(0)
        ) {
            revert ZeroAddress();
        }
        matt = matt_;
        equipment = equipment_;
        randomnessProvider = randomnessProvider_;
        vault = vault_;
        _grantRole(PAUSER_ROLE, admin_);
        _grantRole(PAUSER_ROLE, pauser_);
        _pause();
    }

    function openChest(ChestType chestType)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 requestKey)
    {
        uint256 price = chestPrice[chestType];
        if (price > type(uint96).max) revert PriceTooLarge();
        matt.safeTransferFrom(msg.sender, address(this), price);
        address provider = address(randomnessProvider);
        if (provider == address(0)) revert ZeroAddress();
        uint256 providerRequestId = randomnessProvider.requestRandomWord();
        requestKey = keccak256(abi.encode(provider, providerRequestId));
        if (pendingRequests[requestKey].buyer != address(0)) revert RequestAlreadyExists();
        pendingRequests[requestKey] = PendingRequest({
            buyer: msg.sender,
            price: uint96(price),
            requestedAt: uint40(block.timestamp),
            chestType: chestType
        });
        emit ChestRequested(requestKey, provider, providerRequestId, msg.sender, chestType, price);
    }

    function fulfillRandomness(uint256 providerRequestId, uint256 randomWord)
        external
        override
        nonReentrant
    {
        bytes32 requestKey = keccak256(abi.encode(msg.sender, providerRequestId));
        PendingRequest memory request = pendingRequests[requestKey];
        if (request.buyer == address(0)) revert UnknownRequest();
        delete pendingRequests[requestKey];

        (MattEquipment.ItemType itemType, MattEquipment.Rarity rarity, uint16 armorHp) =
            _rollOutcome(request.chestType, randomWord);
        uint32[] storage pool = _definitionPools[itemType][rarity];
        if (pool.length == 0) revert EmptyDefinitionPool();
        uint32 definitionId = pool[uint256(keccak256(abi.encode(randomWord, requestKey))) % pool.length];

        matt.safeTransfer(vault, request.price);
        uint256 tokenId = equipment.mintEquipment(request.buyer, itemType, rarity, definitionId, armorHp);
        emit ChestFulfilled(requestKey, request.buyer, tokenId, rarity, definitionId);
    }

    function cancelExpiredRequest(address provider, uint256 providerRequestId) external nonReentrant {
        bytes32 requestKey = keccak256(abi.encode(provider, providerRequestId));
        PendingRequest memory request = pendingRequests[requestKey];
        if (request.buyer == address(0)) revert UnknownRequest();
        if (request.buyer != msg.sender) revert NotRequestBuyer();
        if (block.timestamp < uint256(request.requestedAt) + requestTimeout) revert RequestNotExpired();
        delete pendingRequests[requestKey];
        matt.safeTransfer(request.buyer, request.price);
        emit ChestCancelled(requestKey, request.buyer, request.price);
    }

    function purchaseBackpack() external nonReentrant whenNotPaused returns (uint256 tokenId) {
        matt.safeTransferFrom(msg.sender, vault, backpackPrice);
        tokenId = equipment.mintEquipment(
            msg.sender,
            MattEquipment.ItemType.Backpack,
            MattEquipment.Rarity.Common,
            backpackDefinitionId,
            0
        );
        emit BackpackPurchased(msg.sender, tokenId, backpackPrice);
    }

    function definitionPool(MattEquipment.ItemType itemType, MattEquipment.Rarity rarity)
        external
        view
        returns (uint32[] memory)
    {
        return _definitionPools[itemType][rarity];
    }

    function setDefinitionPool(
        MattEquipment.ItemType itemType,
        MattEquipment.Rarity rarity,
        uint32[] calldata definitionIds
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _definitionPools[itemType][rarity] = definitionIds;
        emit DefinitionPoolUpdated(itemType, rarity);
    }

    function setChestPrice(ChestType chestType, uint256 price) external onlyRole(DEFAULT_ADMIN_ROLE) {
        chestPrice[chestType] = price;
        emit PriceUpdated(chestType, price);
    }

    function setBackpackConfiguration(uint256 price, uint32 definitionId)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        backpackPrice = price;
        backpackDefinitionId = definitionId;
        emit BackpackConfigurationUpdated(price, definitionId);
    }

    function setRandomnessConfiguration(IRandomnessProvider provider, uint256 timeout)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (address(provider) == address(0)) revert ZeroAddress();
        randomnessProvider = provider;
        requestTimeout = timeout;
        emit RandomnessConfigurationUpdated(address(provider), timeout);
    }

    function setVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultUpdated(vault_);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _rollOutcome(ChestType chestType, uint256 randomWord)
        private
        pure
        returns (MattEquipment.ItemType itemType, MattEquipment.Rarity rarity, uint16 armorHp)
    {
        uint256 roll = randomWord % 10_000;
        if (chestType == ChestType.Weapon || chestType == ChestType.Helmet) {
            itemType = chestType == ChestType.Weapon
                ? MattEquipment.ItemType.Weapon
                : MattEquipment.ItemType.Helmet;
            if (roll < 6_000) rarity = MattEquipment.Rarity.Common;
            else if (roll < 8_000) rarity = MattEquipment.Rarity.Uncommon;
            else if (roll < 9_200) rarity = MattEquipment.Rarity.Rare;
            else if (roll < 9_900) rarity = MattEquipment.Rarity.Mythic;
            else rarity = MattEquipment.Rarity.Legendary;
            return (itemType, rarity, 0);
        }

        itemType = MattEquipment.ItemType.Armor;
        if (chestType == ChestType.ArmorCommon) return (itemType, MattEquipment.Rarity.Common, 125);

        if (chestType == ChestType.ArmorRare) {
            if (roll < 5_000) return (itemType, MattEquipment.Rarity.Common, 125);
            if (roll < 8_000) return (itemType, MattEquipment.Rarity.Uncommon, 150);
            if (roll < 9_200) return (itemType, MattEquipment.Rarity.Rare, 175);
            if (roll < 9_800) return (itemType, MattEquipment.Rarity.Mythic, 195);
            return (itemType, MattEquipment.Rarity.Legendary, 200);
        }

        if (roll < 5_000) return (itemType, MattEquipment.Rarity.Uncommon, 150);
        if (roll < 7_500) return (itemType, MattEquipment.Rarity.Rare, 175);
        if (roll < 9_000) return (itemType, MattEquipment.Rarity.Mythic, 195);
        return (itemType, MattEquipment.Rarity.Legendary, 200);
    }
}
