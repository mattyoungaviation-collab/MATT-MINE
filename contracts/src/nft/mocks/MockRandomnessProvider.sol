// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRandomnessProvider} from "../interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../interfaces/IRandomnessConsumer.sol";
import {IRandomnessStatus} from "../interfaces/IRandomnessStatus.sol";
import {IRandomnessCancellation} from "../interfaces/IRandomnessCancellation.sol";

/// @notice Local-test adapter only. Never use this predictable provider in production.
contract MockRandomnessProvider is IRandomnessProvider, IRandomnessStatus, IRandomnessCancellation {
    uint256 public nextRequestId = 1;
    mapping(uint256 requestId => address consumer) public consumers;
    mapping(uint256 requestId => bool fulfilled) public fulfilledRequests;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessCancelled(uint256 indexed requestId);

    error UnknownRequest();
    error Unauthorized();

    function requestRandomWord() external returns (uint256 requestId) {
        requestId = nextRequestId++;
        consumers[requestId] = msg.sender;
        emit RandomnessRequested(requestId, msg.sender);
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        address consumer = consumers[requestId];
        if (consumer == address(0)) revert UnknownRequest();
        delete consumers[requestId];
        fulfilledRequests[requestId] = true;
        IRandomnessConsumer(consumer).fulfillRandomness(requestId, randomWord);
    }

    function isRequestFulfilled(uint256 requestId) external view override returns (bool) {
        return fulfilledRequests[requestId];
    }

    function supportsRequestCancellation() external pure override returns (bool) {
        return true;
    }

    function cancelRequest(uint256 requestId) external override {
        address requestConsumer = consumers[requestId];
        if (requestConsumer == address(0)) revert UnknownRequest();
        if (requestConsumer != msg.sender) revert Unauthorized();
        delete consumers[requestId];
        emit RandomnessCancelled(requestId);
    }
}
