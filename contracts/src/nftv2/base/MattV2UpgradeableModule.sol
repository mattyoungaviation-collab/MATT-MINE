// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

abstract contract MattV2UpgradeableModule is
    Initializable,
    AccessControlDefaultAdminRulesUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    address public immutable UPGRADE_TIMELOCK;

    error UnauthorizedUpgrade();
    error ZeroAddress();

    constructor(address upgradeTimelock) {
        if (upgradeTimelock == address(0)) revert ZeroAddress();
        UPGRADE_TIMELOCK = upgradeTimelock;
        _disableInitializers();
    }

    function __MattV2UpgradeableModule_init(address admin, address pauser) internal onlyInitializing {
        if (admin == address(0) || pauser == address(0)) revert ZeroAddress();
        __AccessControlDefaultAdminRules_init(1 days, admin);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _pause();
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _validateUnpause();
        _unpause();
    }

    function _validateUnpause() internal view virtual {}

    /// @dev Existing proxies need one final legacy-timelock upgrade to receive
    /// this authorization path. Afterward the Root/default admin can upgrade
    /// directly, while already-scheduled legacy operations remain executable.
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != UPGRADE_TIMELOCK && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert UnauthorizedUpgrade();
        }
    }
}
