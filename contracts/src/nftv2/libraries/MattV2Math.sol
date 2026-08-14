// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MattV2Types} from "./MattV2Types.sol";

library MattV2Math {
    uint256 internal constant MAX_LEVEL = 100;
    uint256 internal constant LEVEL_100_XP = 360_000;
    uint256 internal constant LEVEL_DENOMINATOR = 99;
    uint256 internal constant BPS = 10_000;

    error InvalidLevel();
    error InvalidPhaseCount();

    function xpThreshold(uint8 level) internal pure returns (uint256) {
        if (level == 0 || level > MAX_LEVEL) revert InvalidLevel();
        uint256 offset = uint256(level) - 1;
        return Math.mulDiv(LEVEL_100_XP, offset * offset, LEVEL_DENOMINATOR * LEVEL_DENOMINATOR);
    }

    function levelForXp(uint256 bankedXp) internal pure returns (uint8) {
        if (bankedXp >= LEVEL_100_XP) return 100;
        uint8 low = 1;
        uint8 high = 99;
        while (low < high) {
            uint8 middle = uint8((uint256(low) + uint256(high) + 1) / 2);
            if (bankedXp >= xpThreshold(middle)) low = middle;
            else high = middle - 1;
        }
        return low;
    }

    function xpForPhases(uint8 completedPhases) internal pure returns (uint256) {
        if (completedPhases > 5) revert InvalidPhaseCount();
        if (completedPhases == 5) return 100;
        if (completedPhases == 4) return 70;
        if (completedPhases == 3) return 45;
        if (completedPhases == 2) return 25;
        if (completedPhases == 1) return 10;
        return 0;
    }

    function baseHealth(uint8 level) internal pure returns (uint16) {
        return uint16(_linear(50, 150, level));
    }

    function pickaxeAttack(uint8 level) internal pure returns (uint16) {
        return uint16(_linear(15, 35, level));
    }

    function blasterAttack(uint8 level) internal pure returns (uint16) {
        return uint16(_linear(5, 30, level));
    }

    function dynamiteAttack(uint8 level) internal pure returns (uint16) {
        return uint16(_linear(20, 80, level));
    }

    function healAmount(uint8 level) internal pure returns (uint16) {
        return uint16(_linear(10, 50, level));
    }

    function baseCarryCapacity(uint8 level) internal pure returns (uint16) {
        return uint16(_linear(750, 1_500, level));
    }

    function deathRetentionBps(uint8 level) internal pure returns (uint16) {
        return uint16(_linear(1_000, 5_000, level));
    }

    function equipmentBonus(MattV2Types.Slot slot, MattV2Types.Rarity rarity)
        internal
        pure
        returns (uint16)
    {
        uint16 tier = uint16(uint8(rarity)) + 1;
        if (slot == MattV2Types.Slot.Armor) return tier == 5 ? 150 : 25 * tier;
        if (slot == MattV2Types.Slot.Pickaxe || slot == MattV2Types.Slot.Blaster) return 2 * tier;
        if (slot == MattV2Types.Slot.Dynamite || slot == MattV2Types.Slot.Helmet) return 5 * tier;
        return tier == 5 ? 15_000 : 2_500 * tier;
    }

    function effectiveCarryCapacity(uint256 baseCapacity, uint16 backpackBonusBps)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(baseCapacity, BPS + backpackBonusBps, BPS);
    }

    function rollRarity(uint256 randomWord) internal pure returns (MattV2Types.Rarity) {
        uint256 roll = randomWord % BPS;
        if (roll < 6_800) return MattV2Types.Rarity.Common;
        if (roll < 8_600) return MattV2Types.Rarity.Uncommon;
        if (roll < 9_400) return MattV2Types.Rarity.Rare;
        if (roll < 9_900) return MattV2Types.Rarity.Mythic;
        return MattV2Types.Rarity.Legendary;
    }

    function rollCrystalsPerHour(uint256 randomWord) internal pure returns (uint8) {
        uint256 bandRoll = randomWord % BPS;
        uint256 valueRoll = uint256(keccak256(abi.encode(randomWord, "MATT_MINE_CPH_V2")));
        if (bandRoll < 1_000) return uint8(5 + (valueRoll % 5));
        if (bandRoll < 4_500) return uint8(10 + (valueRoll % 10));
        if (bandRoll < 8_500) return uint8(20 + (valueRoll % 11));
        if (bandRoll < 9_500) return uint8(31 + (valueRoll % 9));
        if (bandRoll < 9_900) return uint8(40 + (valueRoll % 10));
        return 50;
    }

    function _linear(uint256 start, uint256 finish, uint8 level) private pure returns (uint256) {
        if (level == 0 || level > MAX_LEVEL) revert InvalidLevel();
        return start + Math.mulDiv(finish - start, uint256(level) - 1, LEVEL_DENOMINATOR);
    }
}
