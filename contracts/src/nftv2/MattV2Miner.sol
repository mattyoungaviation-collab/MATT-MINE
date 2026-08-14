// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MattV2Math} from "./libraries/MattV2Math.sol";

/// @title MATT Mine Miner V2
/// @notice Permanently non-upgradeable ownership and progression for 1,000 Miners.
contract MattV2Miner is ERC721Royalty, AccessControlDefaultAdminRules, Pausable {
    using Strings for uint256;

    enum EarningStatus {
        NotEligible,
        Earning,
        Inactive
    }

    uint256 public constant MAX_SUPPLY = 1_000;
    uint96 public constant ROYALTY_BPS = 500;
    uint40 public constant ACTIVITY_WINDOW = 7 days;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PROGRESSION_ROLE = keccak256("PROGRESSION_ROLE");
    bytes32 public constant LOCK_ROLE = keccak256("LOCK_ROLE");
    bytes32 public constant PASSIVE_ROLE = keccak256("PASSIVE_ROLE");
    bytes32 public constant METADATA_ROLE = keccak256("METADATA_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Progression {
        uint128 bankedXp;
        uint40 lastVerifiedPlay;
        uint40 activeUntil;
        uint40 cphAssignedAt;
        uint8 level;
        uint8 crystalsPerHour;
    }

    struct MinerTraits {
        uint128 bankedXp;
        uint16 baseHealth;
        uint16 pickaxeAttack;
        uint16 blasterAttack;
        uint16 dynamiteAttack;
        uint16 healAmount;
        uint16 baseCarryCapacity;
        uint16 deathRetentionBps;
        uint8 level;
        uint8 evolution;
        uint8 crystalsPerHour;
        uint40 lastVerifiedPlay;
        uint40 activeUntil;
        uint40 cphAssignedAt;
        EarningStatus earningStatus;
        bool runLocked;
    }

    struct OwnershipCheckpoint {
        uint48 timestamp;
        address owner;
    }

    uint256 public nextTokenId = 1;
    uint64 public metadataRevision = 1;
    string private _metadataBaseURI;
    string public contractURI;

    mapping(uint256 tokenId => Progression) private _progression;
    mapping(uint256 tokenId => bool locked) private _runLocked;
    mapping(uint256 tokenId => OwnershipCheckpoint[]) private _ownershipCheckpoints;

    event MinerMinted(address indexed to, uint256 indexed tokenId);
    event ProgressionApplied(uint256 indexed tokenId, uint256 xpDelta, uint256 bankedXp, uint8 oldLevel, uint8 newLevel);
    event VerifiedPlayRecorded(uint256 indexed tokenId, uint40 playedAt, uint40 activeUntil);
    event PassiveRateAssigned(uint256 indexed tokenId, uint8 crystalsPerHour, uint40 assignedAt);
    event RunLockChanged(uint256 indexed tokenId, bool locked);
    event MetadataConfigurationUpdated(string baseURI, string contractURI, uint64 revision);
    event RoyaltyReceiverUpdated(address indexed receiver);
    event MetadataUpdate(uint256 indexed tokenId);
    event BatchMetadataUpdate(uint256 indexed fromTokenId, uint256 indexed toTokenId);

    error CollectionSoldOut();
    error InvalidQuantity();
    error XpOverflow();
    error MinerRunLocked(uint256 tokenId);
    error PassiveRateAlreadyAssigned();
    error MinerNotLevel100();
    error InvalidPassiveRate();
    error InvalidTimestamp();
    error ZeroAddress();

    constructor(
        address admin,
        address royaltyReceiver,
        string memory metadataBaseURI,
        string memory contractUri
    )
        ERC721("MATT Mine Miners", "MMINER")
        AccessControlDefaultAdminRules(1 days, admin)
    {
        if (admin == address(0) || royaltyReceiver == address(0)) revert ZeroAddress();
        _metadataBaseURI = metadataBaseURI;
        contractURI = contractUri;
        _setDefaultRoyalty(royaltyReceiver, ROYALTY_BPS);
        _grantBootstrapRoles(admin);
        _pause();
    }

    function mint(address to) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256 tokenId) {
        tokenId = _mintOne(to);
    }

    /// @notice Batch entry point suitable for a Launchpad stage contract.
    function mint(address to, uint256 quantity)
        external
        onlyRole(MINTER_ROLE)
        whenNotPaused
        returns (uint256 firstTokenId)
    {
        if (quantity == 0 || quantity > MAX_SUPPLY) revert InvalidQuantity();
        firstTokenId = nextTokenId;
        if (firstTokenId + quantity - 1 > MAX_SUPPLY) revert CollectionSoldOut();
        for (uint256 i; i < quantity; ++i) _mintOne(to);
    }

    function applyXp(uint256 tokenId, uint256 xpDelta)
        external
        onlyRole(PROGRESSION_ROLE)
        returns (uint8 oldLevel, uint8 newLevel)
    {
        _requireOwned(tokenId);
        Progression storage progress = _progression[tokenId];
        oldLevel = progress.level;
        uint256 updatedXp = uint256(progress.bankedXp) + xpDelta;
        if (updatedXp > type(uint128).max) revert XpOverflow();
        progress.bankedXp = uint128(updatedXp);
        newLevel = MattV2Math.levelForXp(updatedXp);
        progress.level = newLevel;
        emit ProgressionApplied(tokenId, xpDelta, updatedXp, oldLevel, newLevel);
        emit MetadataUpdate(tokenId);
    }

    function recordVerifiedPlay(uint256 tokenId, uint40 playedAt)
        external
        onlyRole(PROGRESSION_ROLE)
        returns (uint40 previousActiveUntil, uint40 newActiveUntil)
    {
        _requireOwned(tokenId);
        if (playedAt == 0 || playedAt > block.timestamp) revert InvalidTimestamp();
        Progression storage progress = _progression[tokenId];
        previousActiveUntil = progress.activeUntil;
        progress.lastVerifiedPlay = playedAt;
        newActiveUntil = playedAt + ACTIVITY_WINDOW;
        if (newActiveUntil > previousActiveUntil) progress.activeUntil = newActiveUntil;
        else newActiveUntil = previousActiveUntil;
        emit VerifiedPlayRecorded(tokenId, playedAt, newActiveUntil);
        emit MetadataUpdate(tokenId);
    }

    function assignPassiveRate(uint256 tokenId, uint8 crystalsPerHour, uint40 assignedAt)
        external
        onlyRole(PASSIVE_ROLE)
    {
        _requireOwned(tokenId);
        Progression storage progress = _progression[tokenId];
        if (progress.level != 100) revert MinerNotLevel100();
        if (progress.crystalsPerHour != 0) revert PassiveRateAlreadyAssigned();
        if (crystalsPerHour < 5 || crystalsPerHour > 50) revert InvalidPassiveRate();
        if (assignedAt == 0 || assignedAt > block.timestamp) revert InvalidTimestamp();
        progress.crystalsPerHour = crystalsPerHour;
        progress.cphAssignedAt = assignedAt;
        emit PassiveRateAssigned(tokenId, crystalsPerHour, assignedAt);
        emit MetadataUpdate(tokenId);
    }

    function setRunLocked(uint256 tokenId, bool locked) external onlyRole(LOCK_ROLE) {
        _requireOwned(tokenId);
        _runLocked[tokenId] = locked;
        emit RunLockChanged(tokenId, locked);
    }

    function isRunLocked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return _runLocked[tokenId];
    }

    function progressionOf(uint256 tokenId) external view returns (Progression memory) {
        _requireOwned(tokenId);
        return _progression[tokenId];
    }

    function traitsOf(uint256 tokenId) public view returns (MinerTraits memory traits) {
        _requireOwned(tokenId);
        Progression memory progress = _progression[tokenId];
        uint8 level = progress.level;
        traits = MinerTraits({
            bankedXp: progress.bankedXp,
            baseHealth: MattV2Math.baseHealth(level),
            pickaxeAttack: MattV2Math.pickaxeAttack(level),
            blasterAttack: MattV2Math.blasterAttack(level),
            dynamiteAttack: MattV2Math.dynamiteAttack(level),
            healAmount: MattV2Math.healAmount(level),
            baseCarryCapacity: MattV2Math.baseCarryCapacity(level),
            deathRetentionBps: MattV2Math.deathRetentionBps(level),
            level: level,
            evolution: evolutionForLevel(level),
            crystalsPerHour: progress.crystalsPerHour,
            lastVerifiedPlay: progress.lastVerifiedPlay,
            activeUntil: progress.activeUntil,
            cphAssignedAt: progress.cphAssignedAt,
            earningStatus: _earningStatus(progress),
            runLocked: _runLocked[tokenId]
        });
    }

    function earningStatusOf(uint256 tokenId) external view returns (EarningStatus) {
        _requireOwned(tokenId);
        return _earningStatus(_progression[tokenId]);
    }

    function ownerAt(uint256 tokenId, uint48 timestamp) external view returns (address) {
        OwnershipCheckpoint[] storage checkpoints = _ownershipCheckpoints[tokenId];
        uint256 length = checkpoints.length;
        if (length == 0 || timestamp < checkpoints[0].timestamp) return address(0);
        uint256 low;
        uint256 high = length;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            if (checkpoints[middle].timestamp > timestamp) high = middle;
            else low = middle + 1;
        }
        return checkpoints[low - 1].owner;
    }

    function ownershipCheckpointCount(uint256 tokenId) external view returns (uint256) {
        return _ownershipCheckpoints[tokenId].length;
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

    function _mintOne(address to) private returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        tokenId = nextTokenId;
        if (tokenId > MAX_SUPPLY) revert CollectionSoldOut();
        nextTokenId = tokenId + 1;
        _progression[tokenId].level = 1;
        _safeMint(to, tokenId);
        emit MinerMinted(to, tokenId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        address currentOwner = _ownerOf(tokenId);
        if (currentOwner != address(0) && to != currentOwner && _runLocked[tokenId]) {
            revert MinerRunLocked(tokenId);
        }
        from = super._update(to, tokenId, auth);
        if (from != to) _writeOwnershipCheckpoint(tokenId, to);
    }

    function _writeOwnershipCheckpoint(uint256 tokenId, address owner) private {
        OwnershipCheckpoint[] storage checkpoints = _ownershipCheckpoints[tokenId];
        uint48 timestamp = uint48(block.timestamp);
        uint256 length = checkpoints.length;
        if (length != 0 && checkpoints[length - 1].timestamp == timestamp) {
            checkpoints[length - 1].owner = owner;
        } else {
            checkpoints.push(OwnershipCheckpoint({timestamp: timestamp, owner: owner}));
        }
    }

    function _earningStatus(Progression memory progress) private view returns (EarningStatus) {
        if (progress.level < 100 || progress.crystalsPerHour == 0) return EarningStatus.NotEligible;
        return block.timestamp < progress.activeUntil ? EarningStatus.Earning : EarningStatus.Inactive;
    }

    function _grantBootstrapRoles(address admin) private {
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PROGRESSION_ROLE, admin);
        _grantRole(LOCK_ROLE, admin);
        _grantRole(PASSIVE_ROLE, admin);
        _grantRole(METADATA_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }
}
