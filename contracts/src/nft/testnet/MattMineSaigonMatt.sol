// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Saigon-only MATT stand-in. Never deploy this contract on Ronin mainnet.
contract MattMineSaigonMatt is ERC20, Ownable2Step {
    constructor(address initialOwner, uint256 initialSupply)
        ERC20("Saigon MATT", "MATT")
        Ownable(initialOwner)
    {
        _mint(initialOwner, initialSupply);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
