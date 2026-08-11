// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice London-compatible signature validation for EOAs and ERC-1271 wallets.
/// @dev OpenZeppelin 5.4's general SignatureChecker imports Bytes, whose slice
/// implementation emits the Cancun-only MCOPY opcode. MATT Mine deliberately
/// targets the London EVM profile used by its existing Ronin deployments.
library SignatureCheckerCompat {
    function isValidSignatureNow(address signer, bytes32 hash, bytes memory signature)
        internal
        view
        returns (bool)
    {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(hash, signature);
            return error == ECDSA.RecoverError.NoError && recovered == signer;
        }

        (bool success, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (hash, signature))
        );
        return success
            && result.length >= 32
            && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }
}
