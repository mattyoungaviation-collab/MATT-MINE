// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./MockERC20.sol";

contract MockKatanaRouter {
    address public immutable WRON;
    address public immutable factory;
    MockERC20 public immutable outputToken;
    uint256 public immutable outputRate;

    error DeadlineExpired();
    error InvalidPath();
    error MinimumOutputNotMet();

    constructor(address wron, address matt, uint256 rate) {
        WRON = wron;
        outputToken = MockERC20(matt);
        outputRate = rate;
        factory = address(this);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        _validatePath(path);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * outputRate;
    }

    function swapExactRONForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {
        if (deadline < block.timestamp) {
            revert DeadlineExpired();
        }
        _validatePath(path);
        uint256 amountOut = msg.value * outputRate;
        if (amountOut < amountOutMin) {
            revert MinimumOutputNotMet();
        }

        outputToken.mint(to, amountOut);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = amountOut;
    }

    function _validatePath(address[] calldata path) private view {
        if (path.length != 2 || path[0] != WRON || path[1] != address(outputToken)) {
            revert InvalidPath();
        }
    }
}
