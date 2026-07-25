// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMattMinePass {
    event PassPurchased(address indexed player, uint256 priceRon, uint64 expiresAt);

    function hasActivePass(address player) external view returns (bool);
    function passExpiresAt(address player) external view returns (uint64);
    function passPriceRon() external view returns (uint256);
    function purchasePass() external payable;
}
