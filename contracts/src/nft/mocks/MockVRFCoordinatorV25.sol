// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMockVRFConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}
contract MockVRFCoordinatorV25 {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    uint256 public nextRequestId = 1;
    mapping(uint256 requestId => address requester) public requesters;

    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        requesters[requestId] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        address requester = requesters[requestId];
        require(requester != address(0), "unknown request");
        delete requesters[requestId];
        uint256[] memory randomWords = new uint256[](1);
        randomWords[0] = randomWord;
        IMockVRFConsumer(requester).rawFulfillRandomWords(requestId, randomWords);
    }
}
