// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMattV2UUPSProxy {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

interface IMattV2UUPSImplementation {
    function UPGRADE_TIMELOCK() external view returns (address);
}

/// @title MATT Mine V2 Upgrade Timelock
/// @notice Enforces an immutable 48-hour public delay on every governed module upgrade.
contract MattV2UpgradeTimelock is Ownable2Step, ReentrancyGuard {
    uint48 public constant UPGRADE_DELAY = 48 hours;
    mapping(bytes32 operationId => uint48 readyAt) public readyAt;

    event UpgradeScheduled(
        bytes32 indexed operationId,
        address indexed proxy,
        address indexed implementation,
        bytes32 implementationCodeHash,
        bytes32 salt,
        uint48 readyAt
    );
    event UpgradeCancelled(bytes32 indexed operationId);
    event UpgradeExecuted(bytes32 indexed operationId, address indexed proxy, address indexed implementation);

    error InvalidTarget();
    error OperationAlreadyScheduled();
    error OperationNotScheduled();
    error UpgradeNotReady(uint48 readyAt);
    error UpgradeCallFailed(bytes reason);
    error ImplementationTimelockMismatch();

    constructor(address root) Ownable(root) {
        if (root == address(0)) revert InvalidTarget();
    }

    function operationId(address proxy, address implementation, bytes calldata data, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                proxy,
                implementation,
                implementation.codehash,
                keccak256(data),
                salt
            )
        );
    }

    function schedule(address proxy, address implementation, bytes calldata data, bytes32 salt)
        external
        onlyOwner
        returns (bytes32 id)
    {
        if (proxy.code.length == 0 || implementation.code.length == 0) revert InvalidTarget();
        try IMattV2UUPSImplementation(implementation).UPGRADE_TIMELOCK() returns (address configuredTimelock) {
            if (configuredTimelock != address(this)) revert ImplementationTimelockMismatch();
        } catch {
            revert ImplementationTimelockMismatch();
        }
        id = operationId(proxy, implementation, data, salt);
        if (readyAt[id] != 0) revert OperationAlreadyScheduled();
        uint48 executionTime = uint48(block.timestamp) + UPGRADE_DELAY;
        readyAt[id] = executionTime;
        emit UpgradeScheduled(id, proxy, implementation, implementation.codehash, salt, executionTime);
    }

    function cancel(bytes32 id) external onlyOwner {
        if (readyAt[id] == 0) revert OperationNotScheduled();
        delete readyAt[id];
        emit UpgradeCancelled(id);
    }

    function execute(address proxy, address implementation, bytes calldata data, bytes32 salt)
        external
        onlyOwner
        nonReentrant
    {
        bytes32 id = operationId(proxy, implementation, data, salt);
        uint48 executionTime = readyAt[id];
        if (executionTime == 0) revert OperationNotScheduled();
        if (block.timestamp < executionTime) revert UpgradeNotReady(executionTime);
        delete readyAt[id];
        (bool success, bytes memory reason) = proxy.call(
            abi.encodeCall(IMattV2UUPSProxy.upgradeToAndCall, (implementation, data))
        );
        if (!success) revert UpgradeCallFailed(reason);
        emit UpgradeExecuted(id, proxy, implementation);
    }
}
