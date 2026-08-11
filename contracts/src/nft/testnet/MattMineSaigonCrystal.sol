// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Saigon-only Crystal stand-in. Never deploy this contract on Ronin mainnet.
contract MattMineSaigonCrystal is ERC20, Ownable2Step {
    mapping(address minter => bool allowed) public minters;

    event MinterUpdated(address indexed minter, bool allowed);

    error UnauthorizedMinter();

    constructor(address initialOwner) ERC20("Saigon MATT CRYSTALS", "CRYSTALS") Ownable(initialOwner) {}

    function setMinter(address minter, bool allowed) external onlyOwner {
        minters[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    function mint(address to, uint256 amount) external {
        if (!minters[msg.sender]) revert UnauthorizedMinter();
        _mint(to, amount);
    }
}
