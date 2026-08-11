// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRandomnessProvider {
    function requestRandomWord() external returns (uint256 requestId);
}
