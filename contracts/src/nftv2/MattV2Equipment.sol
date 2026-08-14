// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MattV2Math} from "./libraries/MattV2Math.sol";
import {MattV2Types} from "./libraries/MattV2Types.sol";

/// @title MATT Mine Equipment V2
/// @notice Permanently non-upgradeable ownership and fixed bonuses for all equipment.
contract MattV2Equipment is ERC721Royalty, AccessControlDefaultAdminRules, Pausable {
    using Strings for uint256;

    uint96 public constant ROYALTY_BPS = 500;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant LOADOUT_ROLE = keccak256("LOADOUT_ROLE");
    bytes32 public constant STATE_ROLE = keccak256("STATE_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant METADATA_ROLE = keccak256("METADATA_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct EquipmentData {
        uint32 definitionId;
        uint32 equippedToMiner;
        MattV2Types.Slot slot;
        MattV2Types.Rarity rarity;
        bool damaged;
    }

    uint256 public nextTokenId = 1;
    uint64 public metadataRevision = 1;
    string private _metadataBaseURI;
    string public contractURI;
    mapping(uint256 tokenId => EquipmentData) private _equipment;

    event EquipmentMinted(
        address indexed to,
        uint256 indexed tokenId,
        MattV2Types.Slot slot,
        MattV2Types.Rarity rarity,
        uint32 definitionId
    );
    event EquipmentAssignmentChanged(uint256 indexed tokenId, uint256 indexed minerId);
    event ArmorDamageChanged(uint256 indexed tokenId, bool damaged);
    event MetadataConfigurationUpdated(string baseURI, string contractURI, uint64 revision);
    event RoyaltyReceiverUpdated(address indexed receiver);
    event MetadataUpdate(uint256 indexed tokenId);
    event BatchMetadataUpdate(uint256 indexed fromTokenId, uint256 indexed toTokenId);

    error ZeroAddress();
    error NotArmor(uint256 tokenId);
    error EquipmentAlreadyAssigned(uint256 tokenId, uint256 minerId);
    error AssignmentMismatch(uint256 tokenId, uint256 minerId);
    error EquippedItemLocked(uint256 tokenId, uint256 minerId);
    error DirectCustodyTransferForbidden(uint256 tokenId);
    error InvalidMinerAssignment(uint256 minerId);

    constructor(
        address admin,
        address royaltyReceiver,
        string memory metadataBaseURI,
        string memory contractUri
    )
        ERC721("MATT Mine Equipment", "MGEAR")
        AccessControlDefaultAdminRules(1 days, admin)
    {
        if (admin == address(0) || royaltyReceiver == address(0)) revert ZeroAddress();
        _metadataBaseURI = metadataBaseURI;
        contractURI = contractUri;
        _setDefaultRoyalty(royaltyReceiver, ROYALTY_BPS);
        _grantBootstrapRoles(admin);
        _pause();
    }

    function mintEquipment(
        address to,
        MattV2Types.Slot slot,
        MattV2Types.Rarity rarity,
        uint32 definitionId
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        tokenId = nextTokenId++;
        _equipment[tokenId] = EquipmentData({
            definitionId: definitionId,
            equippedToMiner: 0,
            slot: slot,
            rarity: rarity,
            damaged: false
        });
        _safeMint(to, tokenId);
        emit EquipmentMinted(to, tokenId, slot, rarity, definitionId);
    }

    function equipmentData(uint256 tokenId) external view returns (EquipmentData memory) {
        _requireOwned(tokenId);
        return _equipment[tokenId];
    }

    function bonusFor(uint256 tokenId) external view returns (uint16) {
        _requireOwned(tokenId);
        EquipmentData memory data = _equipment[tokenId];
        return MattV2Math.equipmentBonus(data.slot, data.rarity);
    }

    function setEquippedToMiner(uint256 tokenId, uint256 minerId) external onlyRole(LOADOUT_ROLE) {
        _requireOwned(tokenId);
        if (minerId > type(uint32).max) revert InvalidMinerAssignment(minerId);
        uint256 current = _equipment[tokenId].equippedToMiner;
        if (minerId != 0 && current != 0) revert EquipmentAlreadyAssigned(tokenId, current);
        if (minerId == 0 && current == 0) revert AssignmentMismatch(tokenId, minerId);
        _equipment[tokenId].equippedToMiner = uint32(minerId);
        emit EquipmentAssignmentChanged(tokenId, minerId);
        emit MetadataUpdate(tokenId);
    }

    function setArmorDamaged(uint256 tokenId, bool damaged) external onlyRole(STATE_ROLE) {
        _requireOwned(tokenId);
        if (_equipment[tokenId].slot != MattV2Types.Slot.Armor) revert NotArmor(tokenId);
        if (_equipment[tokenId].equippedToMiner == 0) revert AssignmentMismatch(tokenId, 0);
        _equipment[tokenId].damaged = damaged;
        emit ArmorDamageChanged(tokenId, damaged);
        emit MetadataUpdate(tokenId);
    }

    function burnEquipped(uint256 tokenId) external onlyRole(BURNER_ROLE) {
        _requireOwned(tokenId);
        uint256 minerId = _equipment[tokenId].equippedToMiner;
        if (minerId == 0) revert AssignmentMismatch(tokenId, 0);
        delete _equipment[tokenId];
        _burn(tokenId);
    }

    function setMetadataConfiguration(string calldata baseURI, string calldata contractUri)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _metadataBaseURI = baseURI;
        contractURI = contractUri;
        metadataRevision += 1;
        emit MetadataConfigurationUpdated(baseURI, contractUri, metadataRevision);
        if (nextTokenId > 1) emit BatchMetadataUpdate(1, nextTokenId - 1);
    }

    function setRoyaltyReceiver(address receiver) external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        if (receiver == address(0)) revert ZeroAddress();
        _setDefaultRoyalty(receiver, ROYALTY_BPS);
        emit RoyaltyReceiverUpdated(receiver);
    }

    function refreshMetadata(uint256 tokenId) external onlyRole(METADATA_ROLE) {
        _requireOwned(tokenId);
        emit MetadataUpdate(tokenId);
    }

    function pauseMinting() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpauseMinting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_metadataBaseURI, tokenId.toString(), ".json?v=", uint256(metadataRevision).toString());
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Royalty, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        uint256 minerId = _equipment[tokenId].equippedToMiner;
        address currentOwner = _ownerOf(tokenId);
        if (currentOwner != address(0) && to != address(0) && hasRole(LOADOUT_ROLE, to) && auth != to) {
            revert DirectCustodyTransferForbidden(tokenId);
        }
        if (currentOwner != address(0) && to != currentOwner && to != address(0) && minerId != 0) {
            revert EquippedItemLocked(tokenId, minerId);
        }
        return super._update(to, tokenId, auth);
    }

    function _grantBootstrapRoles(address admin) private {
        _grantRole(MINTER_ROLE, admin);
        _grantRole(LOADOUT_ROLE, admin);
        _grantRole(STATE_ROLE, admin);
        _grantRole(BURNER_ROLE, admin);
        _grantRole(METADATA_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }
}
