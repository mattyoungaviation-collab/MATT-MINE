// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title MATT Mine Equipment
/// @notice Individually tradable weapons, backpacks, helmets, and armor.
contract MattEquipment is ERC721, AccessControlDefaultAdminRules {
    using Strings for uint256;

    enum ItemType {
        Weapon,
        Backpack,
        Helmet,
        Armor
    }

    enum Rarity {
        Common,
        Uncommon,
        Rare,
        Mythic,
        Legendary
    }

    struct EquipmentData {
        uint32 definitionId;
        uint16 armorHp;
        ItemType itemType;
        Rarity rarity;
        bool damaged;
        uint256 equippedToMiner;
    }

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant LOADOUT_ROLE = keccak256("LOADOUT_ROLE");
    bytes32 public constant STATE_ROLE = keccak256("STATE_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    uint256 public nextTokenId = 1;
    uint64 public metadataRevision = 1;
    string private _metadataBaseURI;
    string public contractURI;
    mapping(uint256 tokenId => EquipmentData) private _equipment;

    event EquipmentMinted(
        address indexed to,
        uint256 indexed tokenId,
        ItemType itemType,
        Rarity rarity,
        uint32 definitionId,
        uint16 armorHp
    );
    event EquipmentAssignmentChanged(uint256 indexed tokenId, uint256 indexed minerId);
    event ArmorDamageChanged(uint256 indexed tokenId, bool damaged);
    event MetadataConfigurationUpdated(string baseURI, string contractURI, uint64 revision);

    error InvalidArmorConfiguration();
    error NotArmor(uint256 tokenId);
    error EquippedItemLocked(uint256 tokenId, uint256 minerId);

    constructor(address admin_, string memory baseURI_, string memory contractURI_)
        ERC721("MATT Mine Equipment", "MGEAR")
        AccessControlDefaultAdminRules(1 days, admin_)
    {
        _metadataBaseURI = baseURI_;
        contractURI = contractURI_;
    }

    function mintEquipment(
        address to,
        ItemType itemType,
        Rarity rarity,
        uint32 definitionId,
        uint16 armorHp
    ) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        if ((itemType == ItemType.Armor) != (armorHp > 0)) revert InvalidArmorConfiguration();
        tokenId = nextTokenId++;
        _equipment[tokenId] = EquipmentData({
            definitionId: definitionId,
            armorHp: armorHp,
            itemType: itemType,
            rarity: rarity,
            damaged: false,
            equippedToMiner: 0
        });
        _safeMint(to, tokenId);
        emit EquipmentMinted(to, tokenId, itemType, rarity, definitionId, armorHp);
    }

    function equipmentData(uint256 tokenId) external view returns (EquipmentData memory) {
        _requireOwned(tokenId);
        return _equipment[tokenId];
    }

    function setEquippedToMiner(uint256 tokenId, uint256 minerId) external onlyRole(LOADOUT_ROLE) {
        _requireOwned(tokenId);
        _equipment[tokenId].equippedToMiner = minerId;
        emit EquipmentAssignmentChanged(tokenId, minerId);
        emit MetadataUpdate(tokenId);
    }

    function setArmorDamaged(uint256 tokenId, bool damaged_) external onlyRole(STATE_ROLE) {
        _requireOwned(tokenId);
        if (_equipment[tokenId].itemType != ItemType.Armor) revert NotArmor(tokenId);
        _equipment[tokenId].damaged = damaged_;
        emit ArmorDamageChanged(tokenId, damaged_);
        emit MetadataUpdate(tokenId);
    }

    function burnEquipped(uint256 tokenId) external onlyRole(BURNER_ROLE) {
        _requireOwned(tokenId);
        delete _equipment[tokenId];
        _burn(tokenId);
    }

    function setMetadataConfiguration(string calldata baseURI_, string calldata contractURI_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _metadataBaseURI = baseURI_;
        contractURI = contractURI_;
        metadataRevision += 1;
        emit MetadataConfigurationUpdated(baseURI_, contractURI_, metadataRevision);
        emit BatchMetadataUpdate(1, nextTokenId - 1);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_metadataBaseURI, tokenId.toString(), ".json?v=", uint256(metadataRevision).toString());
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        uint256 minerId = _equipment[tokenId].equippedToMiner;
        if (to != address(0) && minerId != 0) revert EquippedItemLocked(tokenId, minerId);
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }

    event MetadataUpdate(uint256 indexed tokenId);
    event BatchMetadataUpdate(uint256 indexed fromTokenId, uint256 indexed toTokenId);
}
