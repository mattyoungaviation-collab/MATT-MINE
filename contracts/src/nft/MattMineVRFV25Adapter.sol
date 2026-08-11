// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRandomnessProvider} from "./interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "./interfaces/IRandomnessConsumer.sol";

interface IVRFCoordinatorV2PlusForMattMine {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata request) external returns (uint256 requestId);
}
/// @title MATT Mine VRF V2.5 Adapter
/// @notice Dedicated Mine consumer for the existing native-RON VRF subscription.
contract MattMineVRFV25Adapter is Ownable2Step, ReentrancyGuard, IRandomnessProvider {
    bytes4 private constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    struct Request {
        uint256 randomWord;
        bool exists;
        bool fulfilled;
        bool delivered;
    }

    IVRFCoordinatorV2PlusForMattMine public immutable vrfCoordinator;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint16 public immutable requestConfirmations;
    uint32 public immutable callbackGasLimit;
    uint32 public immutable maximumConsumerCallbackGasLimit;

    address public consumer;
    uint256 public outstandingRequests;
    mapping(uint256 requestId => Request request) public requests;

    event ConsumerConfigured(address indexed consumer);
    event RandomWordRequested(uint256 indexed requestId, address indexed consumer);
    event RandomWordReceived(uint256 indexed requestId, uint256 randomWord);
    event RandomWordDelivery(uint256 indexed requestId, bool success);

    error Unauthorized();
    error InvalidAddress();
    error InvalidConfiguration();
    error InvalidRequest();
    error ConsumerAlreadyConfigured();
    error RequestAlreadyFulfilled();
    error RequestNotReady();

    constructor(
        address coordinatorAddress,
        uint256 vrfSubscriptionId,
        bytes32 provingKeyHash,
        address initialOwner,
        uint16 minimumConfirmations,
        uint32 coordinatorCallbackGasLimit,
        uint32 maximumMineCallbackGasLimit
    ) Ownable(initialOwner) {
        if (coordinatorAddress == address(0) || coordinatorAddress.code.length == 0 || initialOwner == address(0)) {
            revert InvalidAddress();
        }
        if (
            vrfSubscriptionId == 0 || provingKeyHash == bytes32(0) || minimumConfirmations == 0
                || coordinatorCallbackGasLimit == 0 || maximumMineCallbackGasLimit == 0
                || coordinatorCallbackGasLimit <= maximumMineCallbackGasLimit
        ) revert InvalidConfiguration();

        vrfCoordinator = IVRFCoordinatorV2PlusForMattMine(coordinatorAddress);
        subscriptionId = vrfSubscriptionId;
        keyHash = provingKeyHash;
        requestConfirmations = minimumConfirmations;
        callbackGasLimit = coordinatorCallbackGasLimit;
        maximumConsumerCallbackGasLimit = maximumMineCallbackGasLimit;
    }

    function setConsumer(address newConsumer) external onlyOwner {
        if (consumer != address(0)) revert ConsumerAlreadyConfigured();
        if (newConsumer == address(0) || newConsumer.code.length == 0) revert InvalidAddress();
        consumer = newConsumer;
        emit ConsumerConfigured(newConsumer);
    }

    function requestRandomWord() external nonReentrant returns (uint256 requestId) {
        address configuredConsumer = consumer;
        if (msg.sender != configuredConsumer) revert Unauthorized();

        requestId = vrfCoordinator.requestRandomWords(
            IVRFCoordinatorV2PlusForMattMine.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, true)
            })
        );
        if (requestId == 0 || requests[requestId].exists) revert InvalidRequest();
        requests[requestId].exists = true;
        outstandingRequests += 1;
        emit RandomWordRequested(requestId, configuredConsumer);
    }

    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert Unauthorized();
        Request storage request = requests[requestId];
        if (!request.exists || randomWords.length != 1) revert InvalidRequest();
        if (request.fulfilled) revert RequestAlreadyFulfilled();
        request.fulfilled = true;
        request.randomWord = randomWords[0];
        emit RandomWordReceived(requestId, randomWords[0]);
        _tryDelivery(requestId, request);
    }

    function retryFulfillment(uint256 requestId) external nonReentrant returns (bool delivered) {
        Request storage request = requests[requestId];
        if (!request.fulfilled || request.delivered) revert RequestNotReady();
        delivered = _tryDelivery(requestId, request);
    }

    function _tryDelivery(uint256 requestId, Request storage request) internal returns (bool success) {
        (success,) = consumer.call{gas: maximumConsumerCallbackGasLimit}(
            abi.encodeCall(IRandomnessConsumer.fulfillRandomness, (requestId, request.randomWord))
        );
        if (success) {
            request.delivered = true;
            outstandingRequests -= 1;
        }
        emit RandomWordDelivery(requestId, success);
    }
}
