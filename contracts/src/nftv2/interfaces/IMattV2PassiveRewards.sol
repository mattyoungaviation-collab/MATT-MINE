// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMattV2PassiveRewards {
    function recordActivity(uint256 minerId, uint40 playedAt, uint40 previousActiveUntil, uint40 newActiveUntil)
        external;
    function queueLevel100(uint256 minerId) external;
}
