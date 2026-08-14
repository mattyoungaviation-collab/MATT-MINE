// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title MATT Mine Miner NFT
/// @notice A fixed collection of 1,000 evolving miners with persistent progression.
contract MattMiner is ERC721, AccessControlDefaultAdminRules {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PROGRESSION_ROLE = keccak256("PROGRESSION_ROLE");
    bytes32 public constant METADATA_ROLE = keccak256("METADATA_ROLE");
    uint256 public constant MAX_SUPPLY = 1_000;

    struct Progression {
        uint128 bankedXp;
        uint128 xpAtLevel100;
        uint8 level;
    }

    uint256 public nextTokenId = 1;
    uint64 public metadataRevision = 1;
    string private _metadataBaseURI;
    string public contractURI;
    mapping(uint256 tokenId => Progression) private _progression;

    event MinerMinted(address indexed to, uint256 indexed tokenId);
    event ProgressionApplied(uint256 indexed tokenId, uint256 xpDelta, uint8 oldLevel, uint8 newLevel);
    event MetadataConfigurationUpdated(string baseURI, string contractURI, uint64 revision);

    error CollectionSoldOut();
    error InvalidLevel(uint8 oldLevel, uint8 newLevel);
    error XpOverflow();

    constructor(address admin_, string memory baseURI_, string memory contractURI_)
        ERC721("MATT Mine Miner", "MINER")
        AccessControlDefaultAdminRules(1 days, admin_)
    {
        _metadataBaseURI = baseURI_;
        contractURI = contractURI_;
        _grantRole(MINTER_ROLE, admin_);
    }

    function mint(address to) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = nextTokenId;
        if (tokenId > MAX_SUPPLY) revert CollectionSoldOut();
        nextTokenId = tokenId + 1;
        _progression[tokenId].level = 1;
        _safeMint(to, tokenId);
        emit MinerMinted(to, tokenId);
    }

    function applyProgression(uint256 tokenId, uint256 xpDelta, uint8 newLevel)
        external
        onlyRole(PROGRESSION_ROLE)
    {
        _requireOwned(tokenId);
        Progression storage progress = _progression[tokenId];
        uint8 oldLevel = progress.level;
        if (newLevel < oldLevel || newLevel > 100) revert InvalidLevel(oldLevel, newLevel);

        uint256 updatedXp = uint256(progress.bankedXp) + xpDelta;
        if (updatedXp > type(uint128).max) revert XpOverflow();
        progress.bankedXp = uint128(updatedXp);
        progress.level = newLevel;
        if (oldLevel < 100 && newLevel == 100) progress.xpAtLevel100 = uint128(updatedXp);

        emit ProgressionApplied(tokenId, xpDelta, oldLevel, newLevel);
        emit MetadataUpdate(tokenId);
    }

    function progressionOf(uint256 tokenId)
        external
        view
        returns (uint256 bankedXp, uint8 level, uint8 evolution, uint256 prestigeXp)
    {
        _requireOwned(tokenId);
        Progression memory progress = _progression[tokenId];
        bankedXp = progress.bankedXp;
        level = progress.level;
        evolution = evolutionForLevel(level);
        prestigeXp = level == 100 ? bankedXp - progress.xpAtLevel100 : 0;
    }

    function evolutionForLevel(uint8 level) public pure returns (uint8) {
        if (level >= 100) return 6;
        if (level >= 75) return 5;
        if (level >= 50) return 4;
        if (level >= 35) return 3;
        if (level >= 25) return 2;
        if (level >= 10) return 1;
        return 0;
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

    function refreshMetadata(uint256 tokenId) external onlyRole(METADATA_ROLE) {
        _requireOwned(tokenId);
        emit MetadataUpdate(tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_metadataBaseURI, tokenId.toString(), ".json?v=", uint256(metadataRevision).toString());
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }

    /// @dev ERC-4906 metadata refresh events.
    event MetadataUpdate(uint256 indexed tokenId);
    event BatchMetadataUpdate(uint256 indexed fromTokenId, uint256 indexed toTokenId);
}
