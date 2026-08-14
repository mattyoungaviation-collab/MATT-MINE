// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library MattV2Types {
    enum Slot {
        Armor,
        Pickaxe,
        Blaster,
        Dynamite,
        Helmet,
        Backpack
    }

    enum Rarity {
        Common,
        Uncommon,
        Rare,
        Mythic,
        Legendary
    }

    enum Outcome {
        Extraction,
        Death
    }
}
