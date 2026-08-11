// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MattMiner} from "./MattMiner.sol";
import {MattEquipment} from "./MattEquipment.sol";

/// @title MATT Mine Loadout
/// @notice Holds equipped gear in custody so it follows the Miner NFT when the Miner is sold.
contract MattLoadout is AccessControlDefaultAdminRules, IERC721Receiver, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GAME_ROLE = keccak256("GAME_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct MinerLoadout {
        uint256 weapon;
        uint256 backpackHead;
        uint256 backpackTail;
        uint256 helmet;
        uint256 armor;
        uint32 backpackCount;
        bool runLocked;
    }

    MattMiner public immutable miner;
    MattEquipment public immutable equipment;
    IERC20 public immutable matt;
    address public vault;
    uint256 public repairPrice;

    mapping(uint256 minerId => MinerLoadout) private _loadouts;
    mapping(uint256 backpackTokenId => uint256 nextBackpackTokenId) public nextBackpack;
    uint256 private _pendingDepositToken;

    event EquipmentEquipped(uint256 indexed minerId, uint256 indexed equipmentTokenId, MattEquipment.ItemType itemType);
    event EquipmentUnequipped(uint256 indexed minerId, uint256 indexed equipmentTokenId, address indexed recipient);
    event BackpackPromoted(uint256 indexed minerId, uint256 indexed backpackTokenId);
    event RunLockChanged(uint256 indexed minerId, bool locked);
    event DeathApplied(uint256 indexed minerId, uint256 armorTokenId, uint256 burnedBackpackTokenId);
    event ArmorRepaired(uint256 indexed minerId, uint256 indexed armorTokenId, uint256 pricePaid);
    event RepairConfigurationUpdated(address indexed vault, uint256 repairPrice);

    error NotMinerOwner();
    error NotEquipmentOwner();
    error MinerInRun(uint256 minerId);
    error SlotOccupied();
    error ItemNotEquipped();
    error InvalidBackpackPredecessor();
    error UnexpectedNftDeposit();
    error ArmorNotDamaged();
    error ZeroAddress();

    constructor(
        address admin_,
        MattMiner miner_,
        MattEquipment equipment_,
        IERC20 matt_,
        address vault_,
        uint256 repairPrice_,
        address pauser_
    ) AccessControlDefaultAdminRules(1 days, admin_) {
        if (
            address(miner_) == address(0) || address(equipment_) == address(0) || address(matt_) == address(0)
                || vault_ == address(0) || pauser_ == address(0)
        ) revert ZeroAddress();
        miner = miner_;
        equipment = equipment_;
        matt = matt_;
        vault = vault_;
        repairPrice = repairPrice_;
        _grantRole(PAUSER_ROLE, admin_);
        _grantRole(PAUSER_ROLE, pauser_);
        _pause();
    }

    function loadoutOf(uint256 minerId) external view returns (MinerLoadout memory) {
        miner.ownerOf(minerId);
        return _loadouts[minerId];
    }

    function activeBackpack(uint256 minerId) public view returns (uint256) {
        return _loadouts[minerId].backpackHead;
    }

    function isRunLocked(uint256 minerId) external view returns (bool) {
        miner.ownerOf(minerId);
        return _loadouts[minerId].runLocked;
    }

    function effectiveHitPoints(uint256 minerId) external view returns (uint16) {
        miner.ownerOf(minerId);
        uint256 armorTokenId = _loadouts[minerId].armor;
        if (armorTokenId == 0) return 100;
        MattEquipment.EquipmentData memory data = equipment.equipmentData(armorTokenId);
        return data.damaged ? 100 : data.armorHp;
    }

    function equip(uint256 minerId, uint256 equipmentTokenId) external nonReentrant whenNotPaused {
        _requireMinerOwner(minerId);
        MinerLoadout storage current = _loadouts[minerId];
        if (current.runLocked) revert MinerInRun(minerId);
        if (equipment.ownerOf(equipmentTokenId) != msg.sender) revert NotEquipmentOwner();

        MattEquipment.EquipmentData memory data = equipment.equipmentData(equipmentTokenId);
        if (data.itemType == MattEquipment.ItemType.Weapon && current.weapon != 0) revert SlotOccupied();
        if (data.itemType == MattEquipment.ItemType.Helmet && current.helmet != 0) revert SlotOccupied();
        if (data.itemType == MattEquipment.ItemType.Armor && current.armor != 0) revert SlotOccupied();

        _pendingDepositToken = equipmentTokenId;
        equipment.safeTransferFrom(msg.sender, address(this), equipmentTokenId);
        _pendingDepositToken = 0;

        if (data.itemType == MattEquipment.ItemType.Weapon) {
            current.weapon = equipmentTokenId;
        } else if (data.itemType == MattEquipment.ItemType.Helmet) {
            current.helmet = equipmentTokenId;
        } else if (data.itemType == MattEquipment.ItemType.Armor) {
            current.armor = equipmentTokenId;
        } else {
            _appendBackpack(minerId, current, equipmentTokenId);
        }

        equipment.setEquippedToMiner(equipmentTokenId, minerId);
        miner.refreshMetadata(minerId);
        emit EquipmentEquipped(minerId, equipmentTokenId, data.itemType);
    }

    /// @param previousBackpackTokenId Use zero for the active backpack or for non-backpack items.
    function unequip(uint256 minerId, uint256 equipmentTokenId, uint256 previousBackpackTokenId)
        external
        nonReentrant
        whenNotPaused
    {
        _requireMinerOwner(minerId);
        MinerLoadout storage current = _loadouts[minerId];
        if (current.runLocked) revert MinerInRun(minerId);
        MattEquipment.EquipmentData memory data = equipment.equipmentData(equipmentTokenId);
        if (data.equippedToMiner != minerId) revert ItemNotEquipped();

        if (data.itemType == MattEquipment.ItemType.Weapon) {
            if (current.weapon != equipmentTokenId) revert ItemNotEquipped();
            current.weapon = 0;
        } else if (data.itemType == MattEquipment.ItemType.Helmet) {
            if (current.helmet != equipmentTokenId) revert ItemNotEquipped();
            current.helmet = 0;
        } else if (data.itemType == MattEquipment.ItemType.Armor) {
            if (current.armor != equipmentTokenId) revert ItemNotEquipped();
            current.armor = 0;
        } else {
            _removeBackpack(current, equipmentTokenId, previousBackpackTokenId);
        }

        equipment.setEquippedToMiner(equipmentTokenId, 0);
        equipment.safeTransferFrom(address(this), msg.sender, equipmentTokenId);
        miner.refreshMetadata(minerId);
        emit EquipmentUnequipped(minerId, equipmentTokenId, msg.sender);
    }

    function setRunLocked(uint256 minerId, bool locked) external onlyRole(GAME_ROLE) {
        miner.ownerOf(minerId);
        _loadouts[minerId].runLocked = locked;
        emit RunLockChanged(minerId, locked);
    }

    function applyDeath(uint256 minerId)
        external
        onlyRole(GAME_ROLE)
        nonReentrant
        returns (uint256 burnedBackpackTokenId)
    {
        miner.ownerOf(minerId);
        MinerLoadout storage current = _loadouts[minerId];
        uint256 armorTokenId = current.armor;
        if (armorTokenId != 0) equipment.setArmorDamaged(armorTokenId, true);

        burnedBackpackTokenId = current.backpackHead;
        if (burnedBackpackTokenId != 0) {
            uint256 promoted = nextBackpack[burnedBackpackTokenId];
            delete nextBackpack[burnedBackpackTokenId];
            current.backpackHead = promoted;
            current.backpackCount -= 1;
            if (promoted == 0) current.backpackTail = 0;
            equipment.burnEquipped(burnedBackpackTokenId);
            if (promoted != 0) emit BackpackPromoted(minerId, promoted);
        }
        current.runLocked = false;
        miner.refreshMetadata(minerId);
        emit DeathApplied(minerId, armorTokenId, burnedBackpackTokenId);
    }

    function applyExtraction(uint256 minerId) external onlyRole(GAME_ROLE) {
        miner.ownerOf(minerId);
        _loadouts[minerId].runLocked = false;
        emit RunLockChanged(minerId, false);
    }

    function repairArmor(uint256 minerId) external nonReentrant whenNotPaused {
        _requireMinerOwner(minerId);
        MinerLoadout storage current = _loadouts[minerId];
        if (current.runLocked) revert MinerInRun(minerId);
        uint256 armorTokenId = current.armor;
        if (armorTokenId == 0) revert ItemNotEquipped();
        MattEquipment.EquipmentData memory data = equipment.equipmentData(armorTokenId);
        if (!data.damaged) revert ArmorNotDamaged();
        matt.safeTransferFrom(msg.sender, vault, repairPrice);
        equipment.setArmorDamaged(armorTokenId, false);
        miner.refreshMetadata(minerId);
        emit ArmorRepaired(minerId, armorTokenId, repairPrice);
    }

    function setRepairConfiguration(address vault_, uint256 repairPrice_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        repairPrice = repairPrice_;
        emit RepairConfigurationUpdated(vault_, repairPrice_);
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
        if (miner.ownerOf(minerId) != msg.sender) revert NotMinerOwner();
    }

    function _appendBackpack(uint256 minerId, MinerLoadout storage current, uint256 tokenId) private {
        if (current.backpackTail == 0) {
            current.backpackHead = tokenId;
            current.backpackTail = tokenId;
            emit BackpackPromoted(minerId, tokenId);
        } else {
            nextBackpack[current.backpackTail] = tokenId;
            current.backpackTail = tokenId;
        }
        current.backpackCount += 1;
    }

    function _removeBackpack(MinerLoadout storage current, uint256 tokenId, uint256 previousTokenId) private {
        uint256 nextTokenId = nextBackpack[tokenId];
        if (previousTokenId == 0) {
            if (current.backpackHead != tokenId) revert InvalidBackpackPredecessor();
            current.backpackHead = nextTokenId;
        } else {
            if (nextBackpack[previousTokenId] != tokenId) revert InvalidBackpackPredecessor();
            nextBackpack[previousTokenId] = nextTokenId;
        }
        if (current.backpackTail == tokenId) current.backpackTail = previousTokenId;
        delete nextBackpack[tokenId];
        current.backpackCount -= 1;
    }
}
