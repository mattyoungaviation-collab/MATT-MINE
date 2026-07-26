// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMattMineRuns {
    event PaidRunPurchased(
        address indexed player,
        uint256 indexed entitlementId,
        uint256 ronPaid,
        uint256 mattBought,
        uint256 currentPoolMatt,
        uint256 futureRewardsMatt,
        uint256 reserveMatt
    );

    function paidRunPriceRon() external view returns (uint256);
    function purchasePaidRun(uint256 minMattOut, uint256 deadline) external payable returns (uint256 entitlementId);
}
