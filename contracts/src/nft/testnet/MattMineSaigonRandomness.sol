// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IRandomnessProvider} from "../interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../interfaces/IRandomnessConsumer.sol";

/// @notice Controlled Saigon-only randomness for end-to-end chest rehearsals.
/// @dev The oracle supplies the result, so this MUST NOT be used in production.
contract MattMineSaigonRandomness is Ownable2Step, IRandomnessProvider {
    uint256 public nextRequestId = 1;
    address public oracle;
    mapping(uint256 requestId => address consumer) public consumers;

    event OracleUpdated(address indexed oracle);
    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);

    error InvalidAddress();
    error Unauthorized();
    error UnknownRequest();

    constructor(address initialOwner, address initialOracle) Ownable(initialOwner) {
        if (initialOracle == address(0)) revert InvalidAddress();
        oracle = initialOracle;
    }

    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidAddress();
        oracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    function requestRandomWord() external returns (uint256 requestId) {
        requestId = nextRequestId++;
        consumers[requestId] = msg.sender;
        emit RandomnessRequested(requestId, msg.sender);
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != owner() && msg.sender != oracle) revert Unauthorized();
        address consumer = consumers[requestId];
        if (consumer == address(0)) revert UnknownRequest();
        delete consumers[requestId];
        IRandomnessConsumer(consumer).fulfillRandomness(requestId, randomWord);
        emit RandomnessFulfilled(requestId, randomWord);
    }
}
