// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Consumer-authorized cancellation for requests that have not received randomness.
interface IRandomnessCancellation {
    function supportsRequestCancellation() external view returns (bool);
    function cancelRequest(uint256 requestId) external;
}
