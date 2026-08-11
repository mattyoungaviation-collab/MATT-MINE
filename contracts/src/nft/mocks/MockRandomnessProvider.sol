// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRandomnessProvider} from "../interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../interfaces/IRandomnessConsumer.sol";

/// @notice Local-test adapter only. Never use this predictable provider in production.
contract MockRandomnessProvider is IRandomnessProvider {
    uint256 public nextRequestId = 1;
    mapping(uint256 requestId => address consumer) public consumers;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);

    error UnknownRequest();

    function requestRandomWord() external returns (uint256 requestId) {
        requestId = nextRequestId++;
        consumers[requestId] = msg.sender;
        emit RandomnessRequested(requestId, msg.sender);
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        address consumer = consumers[requestId];
        if (consumer == address(0)) revert UnknownRequest();
        delete consumers[requestId];
        IRandomnessConsumer(consumer).fulfillRandomness(requestId, randomWord);
    }
}
