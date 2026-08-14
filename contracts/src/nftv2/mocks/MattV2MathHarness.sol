// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MattV2Math} from "../libraries/MattV2Math.sol";
import {MattV2Types} from "../libraries/MattV2Types.sol";

/// @notice Test-only exposure of the immutable V2 economy math.
contract MattV2MathHarness {
    function xpThreshold(uint8 level) external pure returns (uint256) {
        return MattV2Math.xpThreshold(level);
    }

    function levelForXp(uint256 xp) external pure returns (uint8) {
        return MattV2Math.levelForXp(xp);
    }

    function xpForPhases(uint8 phases) external pure returns (uint256) {
        return MattV2Math.xpForPhases(phases);
    }

    function equipmentBonus(MattV2Types.Slot slot, MattV2Types.Rarity rarity)
        external
        pure
        returns (uint16)
    {
        return MattV2Math.equipmentBonus(slot, rarity);
    }

    function rollRarity(uint256 randomWord) external pure returns (MattV2Types.Rarity) {
        return MattV2Math.rollRarity(randomWord);
    }

    function rollCrystalsPerHour(uint256 randomWord) external pure returns (uint8) {
        return MattV2Math.rollCrystalsPerHour(randomWord);
    }
}
