// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MattV2Miner} from "./MattV2Miner.sol";
import {MattV2Equipment} from "./MattV2Equipment.sol";
import {MattV2Math} from "./libraries/MattV2Math.sol";
import {MattV2Types} from "./libraries/MattV2Types.sol";

/// @title MATT Mine Loadout V2
/// @notice Non-upgradeable equipment custody whose beneficial owner is the Miner owner.
contract MattV2Loadout is AccessControlDefaultAdminRules, IERC721Receiver, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GAME_ROLE = keccak256("GAME_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct EffectiveTraits {
        uint16 maximumHealth;
        uint16 armorShield;
        uint16 pickaxeAttack;
        uint16 blasterAttack;
        uint16 dynamiteAttack;
        uint16 healAmount;
        uint16 carryCapacity;
        uint16 deathRetentionBps;
        uint8 level;
        uint8 crystalsPerHour;
    }

    MattV2Miner public immutable miner;
    MattV2Equipment public immutable equipment;
    IERC20 public immutable matt;

    address public treasury;
    uint256 public repairPrice;
    mapping(uint256 minerId => uint256[6] tokenIds) private _loadouts;
    uint256 private _pendingDepositToken;

    event EquipmentEquipped(uint256 indexed minerId, uint256 indexed equipmentTokenId, MattV2Types.Slot slot);
    event EquipmentUnequipped(
        uint256 indexed minerId,
        uint256 indexed equipmentTokenId,
        MattV2Types.Slot slot,
        address recipient
    );
    event DeathApplied(uint256 indexed minerId, uint256 armorTokenId, uint256 burnedBackpackTokenId);
    event ArmorRepaired(uint256 indexed minerId, uint256 indexed armorTokenId, uint256 pricePaid);
    event RepairPriceUpdated(uint256 repairPrice);
    event TreasuryUpdated(address indexed treasury);

    error ZeroAddress();
    error NotMinerOwner();
    error NotEquipmentOwner();
    error MinerInRun(uint256 minerId);
    error SlotOccupied(MattV2Types.Slot slot);
    error ItemNotEquipped();
    error UnexpectedNftDeposit();
    error ArmorNotDamaged();
    error InvalidMinerId();
    error InvalidDependency();
    error MinerNotInRun(uint256 minerId);

    constructor(
        address admin,
        MattV2Miner miner_,
        MattV2Equipment equipment_,
        IERC20 matt_,
        address treasury_,
        uint256 repairPrice_
    ) AccessControlDefaultAdminRules(1 days, admin) {
        if (
            admin == address(0) || address(miner_) == address(0) || address(equipment_) == address(0)
                || address(matt_) == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (
            address(miner_).code.length == 0 || address(equipment_).code.length == 0
                || address(matt_).code.length == 0
        ) revert InvalidDependency();
        miner = miner_;
        equipment = equipment_;
        matt = matt_;
        treasury = treasury_;
        repairPrice = repairPrice_;
        _grantRole(GAME_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _pause();
    }

    function loadoutOf(uint256 minerId) external view returns (uint256[6] memory) {
        miner.ownerOf(minerId);
        return _loadouts[minerId];
    }

    function equipmentForSlot(uint256 minerId, MattV2Types.Slot slot) public view returns (uint256) {
        miner.ownerOf(minerId);
        return _loadouts[minerId][uint8(slot)];
    }

    function loadoutHash(uint256 minerId) external view returns (bytes32) {
        miner.ownerOf(minerId);
        return keccak256(abi.encode(_loadouts[minerId]));
    }

    function equip(uint256 minerId, uint256 equipmentTokenId) external nonReentrant whenNotPaused {
        _requireMinerOwner(minerId);
        _requireUnlocked(minerId);
        if (equipment.ownerOf(equipmentTokenId) != msg.sender) revert NotEquipmentOwner();
        MattV2Equipment.EquipmentData memory data = equipment.equipmentData(equipmentTokenId);
        uint8 slotIndex = uint8(data.slot);
        if (_loadouts[minerId][slotIndex] != 0) revert SlotOccupied(data.slot);

        _pendingDepositToken = equipmentTokenId;
        equipment.safeTransferFrom(msg.sender, address(this), equipmentTokenId);
        _pendingDepositToken = 0;
        _loadouts[minerId][slotIndex] = equipmentTokenId;
        equipment.setEquippedToMiner(equipmentTokenId, minerId);
        miner.refreshMetadata(minerId);
        emit EquipmentEquipped(minerId, equipmentTokenId, data.slot);
    }

    function unequip(uint256 minerId, MattV2Types.Slot slot) external nonReentrant whenNotPaused {
        _requireMinerOwner(minerId);
        _requireUnlocked(minerId);
        uint8 slotIndex = uint8(slot);
        uint256 equipmentTokenId = _loadouts[minerId][slotIndex];
        if (equipmentTokenId == 0) revert ItemNotEquipped();
        _loadouts[minerId][slotIndex] = 0;
        equipment.setEquippedToMiner(equipmentTokenId, 0);
        equipment.safeTransferFrom(address(this), msg.sender, equipmentTokenId);
        miner.refreshMetadata(minerId);
        emit EquipmentUnequipped(minerId, equipmentTokenId, slot, msg.sender);
    }

    function applyDeath(uint256 minerId)
        external
        onlyRole(GAME_ROLE)
        nonReentrant
        returns (uint256 burnedBackpackTokenId)
    {
        miner.ownerOf(minerId);
        if (!miner.isRunLocked(minerId)) revert MinerNotInRun(minerId);
        uint256 armorTokenId = _loadouts[minerId][uint8(MattV2Types.Slot.Armor)];
        if (armorTokenId != 0) equipment.setArmorDamaged(armorTokenId, true);

        uint8 backpackIndex = uint8(MattV2Types.Slot.Backpack);
        burnedBackpackTokenId = _loadouts[minerId][backpackIndex];
        if (burnedBackpackTokenId != 0) {
            _loadouts[minerId][backpackIndex] = 0;
            equipment.burnEquipped(burnedBackpackTokenId);
        }
        miner.refreshMetadata(minerId);
        emit DeathApplied(minerId, armorTokenId, burnedBackpackTokenId);
    }

    function repairArmor(uint256 minerId) external nonReentrant whenNotPaused {
        _requireMinerOwner(minerId);
        _requireUnlocked(minerId);
        uint256 armorTokenId = _loadouts[minerId][uint8(MattV2Types.Slot.Armor)];
        if (armorTokenId == 0) revert ItemNotEquipped();
        MattV2Equipment.EquipmentData memory data = equipment.equipmentData(armorTokenId);
        if (!data.damaged) revert ArmorNotDamaged();
        matt.safeTransferFrom(msg.sender, treasury, repairPrice);
        equipment.setArmorDamaged(armorTokenId, false);
        miner.refreshMetadata(minerId);
        emit ArmorRepaired(minerId, armorTokenId, repairPrice);
    }

    function effectiveTraits(uint256 minerId) public view returns (EffectiveTraits memory result) {
        MattV2Miner.MinerTraits memory base = miner.traitsOf(minerId);
        uint256[6] storage current = _loadouts[minerId];
        result = EffectiveTraits({
            maximumHealth: base.baseHealth,
            armorShield: 0,
            pickaxeAttack: base.pickaxeAttack,
            blasterAttack: base.blasterAttack,
            dynamiteAttack: base.dynamiteAttack,
            healAmount: base.healAmount,
            carryCapacity: base.baseCarryCapacity,
            deathRetentionBps: base.deathRetentionBps,
            level: base.level,
            crystalsPerHour: base.crystalsPerHour
        });

        uint256 armorToken = current[uint8(MattV2Types.Slot.Armor)];
        if (armorToken != 0) {
            MattV2Equipment.EquipmentData memory armor = equipment.equipmentData(armorToken);
            if (!armor.damaged) result.armorShield = equipment.bonusFor(armorToken);
        }
        uint256 pickaxe = current[uint8(MattV2Types.Slot.Pickaxe)];
        if (pickaxe != 0) result.pickaxeAttack += equipment.bonusFor(pickaxe);
        uint256 blaster = current[uint8(MattV2Types.Slot.Blaster)];
        if (blaster != 0) result.blasterAttack += equipment.bonusFor(blaster);
        uint256 dynamite = current[uint8(MattV2Types.Slot.Dynamite)];
        if (dynamite != 0) result.dynamiteAttack += equipment.bonusFor(dynamite);
        uint256 helmet = current[uint8(MattV2Types.Slot.Helmet)];
        if (helmet != 0) result.maximumHealth += equipment.bonusFor(helmet);
        uint256 backpack = current[uint8(MattV2Types.Slot.Backpack)];
        if (backpack != 0) {
            result.carryCapacity = uint16(
                MattV2Math.effectiveCarryCapacity(result.carryCapacity, equipment.bonusFor(backpack))
            );
        }
    }

    function setRepairPrice(uint256 repairPrice_) external onlyRole(CONFIG_ROLE) {
        repairPrice = repairPrice_;
        emit RepairPriceUpdated(repairPrice_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function onERC721Received(address operator, address, uint256 tokenId, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(equipment) || operator != address(this) || tokenId != _pendingDepositToken) {
            revert UnexpectedNftDeposit();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    function _requireMinerOwner(uint256 minerId) private view {
        if (minerId == 0) revert InvalidMinerId();
        if (miner.ownerOf(minerId) != msg.sender) revert NotMinerOwner();
    }

    function _requireUnlocked(uint256 minerId) private view {
        if (miner.isRunLocked(minerId)) revert MinerInRun(minerId);
    }
}
