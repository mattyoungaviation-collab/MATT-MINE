// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMattV2CrystalBank {
    function credit(address player, uint256 amount, bytes32 runId) external;
    function tokenUnit() external view returns (uint256);
}
