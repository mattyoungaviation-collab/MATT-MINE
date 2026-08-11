// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only stand-in for the already deployed MATT token.
contract MockMattToken is ERC20 {
    constructor(address holder, uint256 supply) ERC20("Mock MATT", "MATT") {
        _mint(holder, supply);
    }
}
