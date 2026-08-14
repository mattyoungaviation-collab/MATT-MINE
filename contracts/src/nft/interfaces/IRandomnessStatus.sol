// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRandomnessStatus {
    function isRequestFulfilled(uint256 requestId) external view returns (bool);
}
