// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IKatanaRouter {
    function WRON() external view returns (address);
    function factory() external view returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactRONForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}
