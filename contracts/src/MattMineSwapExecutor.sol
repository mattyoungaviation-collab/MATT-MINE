// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IKatanaRouter} from "../interfaces/IKatanaRouter.sol";
import {IMattMineSwapExecutor} from "../interfaces/IMattMineSwapExecutor.sol";

contract MattMineSwapExecutor is IMattMineSwapExecutor, AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant RUNS_ROLE = keccak256("RUNS_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant MAX_DEADLINE_WINDOW = 15 minutes;

    IKatanaRouter public immutable katanaRouter;
    address public immutable wrappedRon;
    address public immutable mattToken;

    error DirectPaymentDisabled();
    error InvalidAddress();
    error InvalidDeadline(uint256 deadline);
    error InvalidMinimumOutput();
    error InvalidSwapResult();

    constructor(
        address initialAdmin,
        address pauser,
        address router,
        address wron,
        address matt
    ) {
        if (
            initialAdmin == address(0) || pauser == address(0) || router == address(0) || wron == address(0)
                || matt == address(0) || router.code.length == 0 || wron.code.length == 0 || matt.code.length == 0
        ) {
            revert InvalidAddress();
        }

        katanaRouter = IKatanaRouter(router);
        wrappedRon = wron;
        mattToken = matt;

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(PAUSER_ROLE, pauser);
    }

    function swapRonForMatt(uint256 minMattOut, uint256 deadline)
        external
        payable
        override
        onlyRole(RUNS_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 mattOut)
    {
        if (msg.value == 0 || minMattOut == 0) {
            revert InvalidMinimumOutput();
        }
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_DEADLINE_WINDOW) {
            revert InvalidDeadline(deadline);
        }

        address[] memory path = new address[](2);
        path[0] = wrappedRon;
        path[1] = mattToken;

        uint256[] memory amounts =
            katanaRouter.swapExactRONForTokens{value: msg.value}(minMattOut, path, msg.sender, deadline);
        if (amounts.length != 2 || amounts[0] != msg.value || amounts[1] < minMattOut) {
            revert InvalidSwapResult();
        }

        mattOut = amounts[1];
        emit RonSwappedForMatt(msg.sender, msg.value, mattOut, deadline);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    receive() external payable {
        revert DirectPaymentDisabled();
    }

    fallback() external payable {
        revert DirectPaymentDisabled();
    }
}
