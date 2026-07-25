// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMattMineRewards {
    enum Board { Free, Pass }

    event RewardEpochPublished(
        uint256 indexed epoch,
        Board indexed board,
        bytes32 merkleRoot,
        uint256 totalMatt,
        uint64 claimDeadline
    );
    event RewardClaimed(uint256 indexed epoch, Board indexed board, address indexed player, uint256 mattAmount);

    function claim(
        uint256 epoch,
        Board board,
        uint256 mattAmount,
        bytes32[] calldata proof
    ) external;

    function isClaimed(uint256 epoch, Board board, address player) external view returns (bool);
}
