// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only stand-in for the already deployed MATT Crystal token.
contract MockMattCrystal is ERC20 {
    mapping(address minter => bool allowed) public minters;

    constructor(address admin) ERC20("Mock MATT Crystal", "MCRYSTAL") {
        minters[admin] = true;
    }

    function setMinter(address minter, bool allowed) external {
        require(minters[msg.sender], "not minter admin");
        minters[minter] = allowed;
    }

    function mint(address to, uint256 amount) external {
        require(minters[msg.sender], "not minter");
        _mint(to, amount);
    }
}
