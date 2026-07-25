// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IMattMineRewards} from "../interfaces/IMattMineRewards.sol";

contract MattMineRewards is IMattMineRewards, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant REWARD_PUBLISHER_ROLE = keccak256("REWARD_PUBLISHER_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant MAX_CLAIM_WINDOW = 90 days;

    IERC20 public immutable mattToken;
    address public reserveTreasury;
    uint256 public totalReservedMatt;

    struct RewardEpoch {
        bytes32 merkleRoot;
        uint256 totalMatt;
        uint256 claimedMatt;
        uint64 claimDeadline;
        bool published;
        bool closed;
    }

    mapping(bytes32 epochKey => RewardEpoch epoch) private _epochs;
    mapping(bytes32 epochKey => mapping(address player => bool claimed)) private _claims;

    error ActiveRewardFundsReserved(uint256 availableMatt, uint256 requestedMatt);
    error ClaimDeadlineExpired();
    error ClaimDeadlineInvalid();
    error ClaimNotExpired();
    error DuplicateClaim();
    error EpochAlreadyClosed();
    error EpochAlreadyPublished();
    error EpochNotPublished();
    error InsufficientRewardFunding(uint256 availableMatt, uint256 requiredMatt);
    error InvalidAddress();
    error InvalidAmount();
    error InvalidMerkleProof();
    error InvalidMerkleRoot();
    error RewardAllocationExceeded(uint256 remainingMatt, uint256 requestedMatt);

    event RewardsFunded(address indexed funder, uint256 mattAmount);
    event RewardEpochClosed(
        uint256 indexed epoch,
        Board indexed board,
        uint256 claimedMatt,
        uint256 returnedMatt
    );
    event UnallocatedRewardsRecovered(uint256 mattAmount);
    event ReserveTreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    constructor(
        address mattAddress,
        address initialAdmin,
        address rewardPublisher,
        address treasuryManager,
        address pauser,
        address initialReserveTreasury
    ) {
        if (
            mattAddress == address(0) || initialAdmin == address(0) || rewardPublisher == address(0)
                || treasuryManager == address(0) || pauser == address(0)
                || initialReserveTreasury == address(0) || mattAddress.code.length == 0
        ) {
            revert InvalidAddress();
        }

        mattToken = IERC20(mattAddress);
        reserveTreasury = initialReserveTreasury;

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(REWARD_PUBLISHER_ROLE, rewardPublisher);
        _grantRole(TREASURY_ROLE, treasuryManager);
        _grantRole(PAUSER_ROLE, pauser);
    }

    function fundRewards(uint256 mattAmount) external {
        if (mattAmount == 0) {
            revert InvalidAmount();
        }
        mattToken.safeTransferFrom(msg.sender, address(this), mattAmount);
        emit RewardsFunded(msg.sender, mattAmount);
    }

    function publishRewardEpoch(
        uint256 epoch,
        Board board,
        bytes32 merkleRoot,
        uint256 totalMatt,
        uint64 claimDeadline
    ) external onlyRole(REWARD_PUBLISHER_ROLE) whenNotPaused {
        bytes32 key = epochKey(epoch, board);
        RewardEpoch storage rewardEpoch = _epochs[key];
        if (rewardEpoch.published) {
            revert EpochAlreadyPublished();
        }
        if (merkleRoot == bytes32(0)) {
            revert InvalidMerkleRoot();
        }
        if (totalMatt == 0) {
            revert InvalidAmount();
        }
        if (
            claimDeadline <= block.timestamp
                || claimDeadline > block.timestamp + MAX_CLAIM_WINDOW
        ) {
            revert ClaimDeadlineInvalid();
        }

        uint256 balance = mattToken.balanceOf(address(this));
        uint256 requiredBalance = totalReservedMatt + totalMatt;
        if (balance < requiredBalance) {
            uint256 availableMatt =
                balance > totalReservedMatt ? balance - totalReservedMatt : 0;
            revert InsufficientRewardFunding(availableMatt, totalMatt);
        }

        rewardEpoch.merkleRoot = merkleRoot;
        rewardEpoch.totalMatt = totalMatt;
        rewardEpoch.claimDeadline = claimDeadline;
        rewardEpoch.published = true;
        totalReservedMatt = requiredBalance;

        emit RewardEpochPublished(epoch, board, merkleRoot, totalMatt, claimDeadline);
    }

    function claim(
        uint256 epoch,
        Board board,
        uint256 mattAmount,
        bytes32[] calldata proof
    ) external override nonReentrant whenNotPaused {
        bytes32 key = epochKey(epoch, board);
        RewardEpoch storage rewardEpoch = _epochs[key];
        if (!rewardEpoch.published) {
            revert EpochNotPublished();
        }
        if (rewardEpoch.closed) {
            revert EpochAlreadyClosed();
        }
        if (block.timestamp > rewardEpoch.claimDeadline) {
            revert ClaimDeadlineExpired();
        }
        if (_claims[key][msg.sender]) {
            revert DuplicateClaim();
        }
        if (mattAmount == 0) {
            revert InvalidAmount();
        }
        uint256 remainingMatt = rewardEpoch.totalMatt - rewardEpoch.claimedMatt;
        if (mattAmount > remainingMatt) {
            revert RewardAllocationExceeded(remainingMatt, mattAmount);
        }

        bytes32 leaf = rewardLeaf(epoch, board, msg.sender, mattAmount);
        if (!MerkleProof.verifyCalldata(proof, rewardEpoch.merkleRoot, leaf)) {
            revert InvalidMerkleProof();
        }

        _claims[key][msg.sender] = true;
        rewardEpoch.claimedMatt += mattAmount;
        totalReservedMatt -= mattAmount;
        mattToken.safeTransfer(msg.sender, mattAmount);

        emit RewardClaimed(epoch, board, msg.sender, mattAmount);
    }

    function recoverExpiredRewards(uint256 epoch, Board board)
        external
        onlyRole(TREASURY_ROLE)
        nonReentrant
    {
        bytes32 key = epochKey(epoch, board);
        RewardEpoch storage rewardEpoch = _epochs[key];
        if (!rewardEpoch.published) {
            revert EpochNotPublished();
        }
        if (rewardEpoch.closed) {
            revert EpochAlreadyClosed();
        }
        if (block.timestamp <= rewardEpoch.claimDeadline) {
            revert ClaimNotExpired();
        }

        uint256 remainingMatt = rewardEpoch.totalMatt - rewardEpoch.claimedMatt;
        rewardEpoch.closed = true;
        totalReservedMatt -= remainingMatt;
        if (remainingMatt > 0) {
            mattToken.safeTransfer(reserveTreasury, remainingMatt);
        }

        emit RewardEpochClosed(epoch, board, rewardEpoch.claimedMatt, remainingMatt);
    }

    function recoverUnallocatedRewards(uint256 mattAmount)
        external
        onlyRole(TREASURY_ROLE)
        nonReentrant
    {
        if (mattAmount == 0) {
            revert InvalidAmount();
        }
        uint256 balance = mattToken.balanceOf(address(this));
        uint256 availableMatt =
            balance > totalReservedMatt ? balance - totalReservedMatt : 0;
        if (mattAmount > availableMatt) {
            revert ActiveRewardFundsReserved(availableMatt, mattAmount);
        }
        mattToken.safeTransfer(reserveTreasury, mattAmount);
        emit UnallocatedRewardsRecovered(mattAmount);
    }

    function setReserveTreasury(address newReserveTreasury)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
    {
        if (newReserveTreasury == address(0)) {
            revert InvalidAddress();
        }
        address previousTreasury = reserveTreasury;
        reserveTreasury = newReserveTreasury;
        emit ReserveTreasuryUpdated(previousTreasury, newReserveTreasury);
    }

    function getEpoch(uint256 epoch, Board board) external view returns (RewardEpoch memory) {
        return _epochs[epochKey(epoch, board)];
    }

    function isClaimed(uint256 epoch, Board board, address player)
        external
        view
        override
        returns (bool)
    {
        return _claims[epochKey(epoch, board)][player];
    }

    function rewardLeaf(uint256 epoch, Board board, address player, uint256 mattAmount)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        block.chainid,
                        address(this),
                        epoch,
                        uint8(board),
                        player,
                        mattAmount
                    )
                )
            )
        );
    }

    function epochKey(uint256 epoch, Board board) public pure returns (bytes32) {
        return keccak256(abi.encode(epoch, board));
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
