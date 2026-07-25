// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMattMineSwapExecutor {
    event RonSwappedForMatt(uint256 ronIn, uint256 mattOut, uint256 deadline);

    function swapRonForMatt(uint256 minMattOut, uint256 deadline) external payable returns (uint256 mattOut);
}
