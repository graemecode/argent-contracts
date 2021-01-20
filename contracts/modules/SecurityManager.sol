// Copyright (C) 2018  Argent Labs Ltd. <https://argent.xyz>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.12;

import "./common/Utils.sol";
import "./common/RelayerManager.sol";
import "../wallet/IWallet.sol";
import "../infrastructure/storage/IGuardianStorage.sol";

/**
 * @title RecoveryManager
 * @notice Feature to manage the recovery of a wallet owner.
 * Recovery is executed by a consensus of the wallet's guardians and takes 24 hours before it can be finalized.
 * Once finalised the ownership of the wallet is transfered to a new address.
 * @author Julien Niset - <julien@argent.xyz>
 * @author Olivier Van Den Biggelaar - <olivier@argent.xyz>
 */
contract SecurityManager is RelayerManager {

    bytes32 constant NAME = "SecurityManager";

    bytes4 constant internal EXECUTE_RECOVERY_PREFIX = bytes4(keccak256("executeRecovery(address,address)"));
    bytes4 constant internal FINALIZE_RECOVERY_PREFIX = bytes4(keccak256("finalizeRecovery(address)"));
    bytes4 constant internal CANCEL_RECOVERY_PREFIX = bytes4(keccak256("cancelRecovery(address)"));
    bytes4 constant internal TRANSFER_OWNERSHIP_PREFIX = bytes4(keccak256("transferOwnership(address,address)"));
    bytes4 constant internal LOCK_PREFIX = bytes4(keccak256("lock(address)"));
    bytes4 constant internal UNLOCK_PREFIX = bytes4(keccak256("unlock(address)"));
    bytes4 constant internal ADD_GUARDIAN_PREFIX = bytes4(keccak256("addGuardian(address,address)"));
    bytes4 constant internal CANCEL_GUARDIAN_ADDITION_PREFIX = bytes4(keccak256("cancelGuardianAddition(address,address)"));
    bytes4 constant internal REVOKE_GUARDIAN_PREFIX = bytes4(keccak256("revokeGuardian(address,address)"));
    bytes4 constant internal CANCEL_GUARDIAN_REVOKATION_PREFIX = bytes4(keccak256("cancelGuardianRevokation(address,address)"));
    bytes4 constant internal CONFIRM_GUARDIAN_ADDITION_PREFIX = bytes4(keccak256("confirmGuardianAddition(address,address)"));
    bytes4 constant internal CONFIRM_GUARDIAN_REVOKATION_PREFIX = bytes4(keccak256("confirmGuardianRevokation(address,address)"));

    struct RecoveryConfig {
        address recovery;
        uint64 executeAfter;
        uint32 guardianCount;
    }

    struct GuardianManagerConfig {
        // The time at which a guardian addition or revokation will be confirmable by the owner
        mapping (bytes32 => uint256) pending;
    }

    // Wallet specific recovery storage
    mapping (address => RecoveryConfig) internal recoveryConfigs;
    // The wallet specific storage
    mapping (address => GuardianManagerConfig) internal guardianConfigs;

    // Recovery period
    uint256 public recoveryPeriod;
    // Lock period
    uint256 public lockPeriod;
    // The security period
    uint256 public securityPeriod;
    // The security window
    uint256 public securityWindow;

    // *************** Events *************************** //

    event RecoveryExecuted(address indexed wallet, address indexed _recovery, uint64 executeAfter);
    event RecoveryFinalized(address indexed wallet, address indexed _recovery);
    event RecoveryCanceled(address indexed wallet, address indexed _recovery);
    event OwnershipTransfered(address indexed wallet, address indexed _newOwner);
    event Locked(address indexed wallet, uint64 releaseAfter);
    event Unlocked(address indexed wallet);
    event GuardianAdditionRequested(address indexed wallet, address indexed guardian, uint256 executeAfter);
    event GuardianRevokationRequested(address indexed wallet, address indexed guardian, uint256 executeAfter);
    event GuardianAdditionCancelled(address indexed wallet, address indexed guardian);
    event GuardianRevokationCancelled(address indexed wallet, address indexed guardian);
    event GuardianAdded(address indexed wallet, address indexed guardian);
    event GuardianRevoked(address indexed wallet, address indexed guardian);

    // *************** Modifiers ************************ //

    /**
     * @notice Throws if there is no ongoing recovery procedure.
     */
    modifier onlyWhenRecovery(address _wallet) {
        require(recoveryConfigs[_wallet].executeAfter > 0, "RM: there must be an ongoing recovery");
        _;
    }

    /**
     * @notice Throws if there is an ongoing recovery procedure.
     */
    modifier notWhenRecovery(address _wallet) {
        require(recoveryConfigs[_wallet].executeAfter == 0, "RM: there cannot be an ongoing recovery");
        _;
    }

    /**
     * @notice Throws if the caller is not a guardian for the wallet.
     */
    modifier onlyGuardianOrSelf(address _wallet) {
        bool isGuardian = guardianStorage.isGuardian(_wallet, msg.sender);
        require(msg.sender == address(this)|| isGuardian, "SM: must be guardian or feature");
        _;
    }

    // *************** Constructor ************************ //

    constructor(
        IModuleRegistry _registry,
        ILockStorage _lockStorage,
        IGuardianStorage _guardianStorage,
        uint256 _recoveryPeriod,
        uint256 _lockPeriod,
        uint256 _securityPeriod,
        uint256 _securityWindow
    )
        BaseModule(_registry, _lockStorage, NAME)
        RelayerManager(_guardianStorage)
        public
    {
        // For the wallet to be secure we must have recoveryPeriod >= securityPeriod + securityWindow
        // where securityPeriod and securityWindow are the security parameters of adding/removing guardians
        // and confirming large transfers.
        require(_lockPeriod >= _recoveryPeriod, "SM: insecure security periods");
        recoveryPeriod = _recoveryPeriod;
        lockPeriod = _lockPeriod;
        securityPeriod = _securityPeriod;
        securityWindow = _securityWindow;
    }

    // *************** External functions ************************ //

    /**
     * @inheritdoc RelayerManager
     */
    function getRequiredSignatures(address _wallet, bytes calldata _data) public view override returns (uint256, OwnerSignature) {
        bytes4 methodId = Utils.functionPrefix(_data);
        if (methodId == EXECUTE_RECOVERY_PREFIX) {
            uint walletGuardians = guardianStorage.guardianCount(_wallet);
            require(walletGuardians > 0, "SM: no guardians set on wallet");
            uint numberOfSignaturesRequired = Utils.ceil(walletGuardians, 2);
            return (numberOfSignaturesRequired, OwnerSignature.Disallowed);
        }
        if (methodId == CANCEL_RECOVERY_PREFIX) {
            uint numberOfSignaturesRequired = Utils.ceil(recoveryConfigs[_wallet].guardianCount + 1, 2);
            return (numberOfSignaturesRequired, OwnerSignature.Optional);
        }
        if (methodId == TRANSFER_OWNERSHIP_PREFIX) {
            uint majorityGuardians = Utils.ceil(guardianStorage.guardianCount(_wallet), 2);
            uint numberOfSignaturesRequired = SafeMath.add(majorityGuardians, 1);
            return (numberOfSignaturesRequired, OwnerSignature.Required);
        }
        if (methodId == LOCK_PREFIX || methodId == UNLOCK_PREFIX) {
            return (1, OwnerSignature.Disallowed);
        }
        if (methodId == ADD_GUARDIAN_PREFIX ||
            methodId == REVOKE_GUARDIAN_PREFIX ||
            methodId == CANCEL_GUARDIAN_ADDITION_PREFIX ||
            methodId == CANCEL_GUARDIAN_REVOKATION_PREFIX) 
        {
            return (1, OwnerSignature.Required);
        }
        if (methodId == FINALIZE_RECOVERY_PREFIX ||
            methodId == CONFIRM_GUARDIAN_ADDITION_PREFIX ||
            methodId == CONFIRM_GUARDIAN_REVOKATION_PREFIX)
        {
            return (0, OwnerSignature.Anyone);
        }
        revert("SM: unknown method");
    }

    // *************** Recovery functions ************************ //

    /**
     * @notice Lets the guardians start the execution of the recovery procedure.
     * Once triggered the recovery is pending for the security period before it can be finalised.
     * Must be confirmed by N guardians, where N = ((Nb Guardian + 1) / 2).
     * @param _wallet The target wallet.
     * @param _recovery The address to which ownership should be transferred.
     */
    function executeRecovery(address _wallet, address _recovery) external onlySelf() notWhenRecovery(_wallet) {
        validateNewOwner(_wallet, _recovery);
        RecoveryConfig storage config = recoveryConfigs[_wallet];
        config.recovery = _recovery;
        config.executeAfter = uint64(block.timestamp + recoveryPeriod);
        config.guardianCount = uint32(guardianStorage.guardianCount(_wallet));
        setLock(_wallet, block.timestamp + lockPeriod);
        emit RecoveryExecuted(_wallet, _recovery, config.executeAfter);
    }

    /**
     * @notice Finalizes an ongoing recovery procedure if the security period is over.
     * The method is public and callable by anyone to enable orchestration.
     * @param _wallet The target wallet.
     */
    function finalizeRecovery(address _wallet) external onlyWhenRecovery(_wallet) {
        RecoveryConfig storage config = recoveryConfigs[address(_wallet)];
        require(uint64(block.timestamp) > config.executeAfter, "SM: the recovery period is not over yet");
        address recoveryOwner = config.recovery;
        delete recoveryConfigs[_wallet];

        IWallet(_wallet).setOwner(recoveryOwner);
        setLock(_wallet, 0);

        emit RecoveryFinalized(_wallet, recoveryOwner);
    }

    /**
     * @notice Lets the owner cancel an ongoing recovery procedure.
     * Must be confirmed by N guardians, where N = ((Nb Guardian + 1) / 2) - 1.
     * @param _wallet The target wallet.
     */
    function cancelRecovery(address _wallet) external onlySelf() onlyWhenRecovery(_wallet) {
        RecoveryConfig storage config = recoveryConfigs[address(_wallet)];
        address recoveryOwner = config.recovery;
        delete recoveryConfigs[_wallet];
        setLock(_wallet, 0);

        emit RecoveryCanceled(_wallet, recoveryOwner);
    }

    /**
     * @notice Lets the owner transfer the wallet ownership. This is executed immediately.
     * @param _wallet The target wallet.
     * @param _newOwner The address to which ownership should be transferred.
     */
    function transferOwnership(address _wallet, address _newOwner) external onlySelf() onlyWhenUnlocked(_wallet) {
        validateNewOwner(_wallet, _newOwner);
        IWallet(_wallet).setOwner(_newOwner);

        emit OwnershipTransfered(_wallet, _newOwner);
    }

    /**
    * @notice Gets the details of the ongoing recovery procedure if any.
    * @param _wallet The target wallet.
    */
    function getRecovery(address _wallet) external view returns(address _address, uint64 _executeAfter, uint32 _guardianCount) {
        RecoveryConfig storage config = recoveryConfigs[_wallet];
        return (config.recovery, config.executeAfter, config.guardianCount);
    }

    // *************** Lock functions ************************ //

    /**
     * @notice Lets a guardian lock a wallet.
     * @param _wallet The target wallet.
     */
    function lock(address _wallet) external onlyGuardianOrSelf(_wallet) onlyWhenUnlocked(_wallet) {
        setLock(_wallet, block.timestamp + lockPeriod);
        emit Locked(_wallet, uint64(block.timestamp + lockPeriod));
    }

    /**
     * @notice Lets a guardian unlock a locked wallet.
     * @param _wallet The target wallet.
     */
    function unlock(address _wallet) external onlyGuardianOrSelf(_wallet) onlyWhenLocked(_wallet) {
        address locker = lockStorage.getLocker(_wallet);
        require(locker == address(this), "SM: cannot unlock a wallet that was locked by another feature");
        setLock(_wallet, 0);
        emit Unlocked(_wallet);
    }

    /**
     * @notice Returns the release time of a wallet lock or 0 if the wallet is unlocked.
     * @param _wallet The target wallet.
     * @return _releaseAfter The epoch time at which the lock will release (in seconds).
     */
    function getLock(address _wallet) external view returns(uint64 _releaseAfter) {
        uint256 lockEnd = lockStorage.getLock(_wallet);
        if (lockEnd > block.timestamp) {
            _releaseAfter = uint64(lockEnd);
        }
    }

    /**
     * @notice Checks if a wallet is locked.
     * @param _wallet The target wallet.
     * @return _isLocked `true` if the wallet is locked otherwise `false`.
     */
    function isLocked(address _wallet) external view returns (bool _isLocked) {
        return lockStorage.isLocked(_wallet);
    }

    // *************** Guardian functions ************************ //

    /**
     * @notice Lets the owner add a guardian to its wallet.
     * The first guardian is added immediately. All following additions must be confirmed
     * by calling the confirmGuardianAddition() method.
     * @param _wallet The target wallet.
     * @param _guardian The guardian to add.
     */
    function addGuardian(address _wallet, address _guardian) external onlyWalletOwnerOrSelf(_wallet) onlyWhenUnlocked(_wallet) {
        require(!isOwner(_wallet, _guardian), "SM: target guardian cannot be owner");
        require(!isGuardian(_wallet, _guardian), "SM: target is already a guardian");
        // Guardians must either be an EOA or a contract with an owner()
        // method that returns an address with a 5000 gas stipend.
        // Note that this test is not meant to be strict and can be bypassed by custom malicious contracts.
        (bool success,) = _guardian.call{gas: 5000}(abi.encodeWithSignature("owner()"));
        require(success, "SM: guardian must be EOA or implement owner()");
        if (guardianStorage.guardianCount(_wallet) == 0) {
            guardianStorage.addGuardian(_wallet, _guardian);
            emit GuardianAdded(_wallet, _guardian);
        } else {
            bytes32 id = keccak256(abi.encodePacked(_wallet, _guardian, "addition"));
            GuardianManagerConfig storage config = guardianConfigs[_wallet];
            require(
                config.pending[id] == 0 || block.timestamp > config.pending[id] + securityWindow,
                "SM: addition of target as guardian is already pending");
            config.pending[id] = block.timestamp + securityPeriod;
            emit GuardianAdditionRequested(_wallet, _guardian, block.timestamp + securityPeriod);
        }
    }

    /**
     * @notice Confirms the pending addition of a guardian to a wallet.
     * The method must be called during the confirmation window and can be called by anyone to enable orchestration.
     * @param _wallet The target wallet.
     * @param _guardian The guardian.
     */
    function confirmGuardianAddition(address _wallet, address _guardian) external onlyWhenUnlocked(_wallet) {
        bytes32 id = keccak256(abi.encodePacked(_wallet, _guardian, "addition"));
        GuardianManagerConfig storage config = guardianConfigs[_wallet];
        require(config.pending[id] > 0, "SM: no pending addition as guardian for target");
        require(config.pending[id] < block.timestamp, "SM: Too early to confirm guardian addition");
        require(block.timestamp < config.pending[id] + securityWindow, "SM: Too late to confirm guardian addition");
        guardianStorage.addGuardian(_wallet, _guardian);
        emit GuardianAdded(_wallet, _guardian);
        delete config.pending[id];
    }

    /**
     * @notice Lets the owner cancel a pending guardian addition.
     * @param _wallet The target wallet.
     * @param _guardian The guardian.
     */
    function cancelGuardianAddition(address _wallet, address _guardian) external onlyWalletOwnerOrSelf(_wallet) onlyWhenUnlocked(_wallet) {
        bytes32 id = keccak256(abi.encodePacked(_wallet, _guardian, "addition"));
        GuardianManagerConfig storage config = guardianConfigs[_wallet];
        require(config.pending[id] > 0, "SM: no pending addition as guardian for target");
        delete config.pending[id];
        emit GuardianAdditionCancelled(_wallet, _guardian);
    }

    /**
     * @notice Lets the owner revoke a guardian from its wallet.
     * @dev Revokation must be confirmed by calling the confirmGuardianRevokation() method.
     * @param _wallet The target wallet.
     * @param _guardian The guardian to revoke.
     */
    function revokeGuardian(address _wallet, address _guardian) external onlyWalletOwnerOrSelf(_wallet) {
        require(isGuardian(_wallet, _guardian), "SM: must be an existing guardian");
        bytes32 id = keccak256(abi.encodePacked(_wallet, _guardian, "revokation"));
        GuardianManagerConfig storage config = guardianConfigs[_wallet];
        require(
            config.pending[id] == 0 || block.timestamp > config.pending[id] + securityWindow,
            "SM: revokation of target as guardian is already pending"); // TODO need to allow if confirmation window passed
        config.pending[id] = block.timestamp + securityPeriod;
        emit GuardianRevokationRequested(_wallet, _guardian, block.timestamp + securityPeriod);
    }

    /**
     * @notice Confirms the pending revokation of a guardian to a wallet.
     * The method must be called during the confirmation window and can be called by anyone to enable orchestration.
     * @param _wallet The target wallet.
     * @param _guardian The guardian.
     */
    function confirmGuardianRevokation(address _wallet, address _guardian) external {
        bytes32 id = keccak256(abi.encodePacked(_wallet, _guardian, "revokation"));
        GuardianManagerConfig storage config = guardianConfigs[_wallet];
        require(config.pending[id] > 0, "SM: no pending guardian revokation for target");
        require(config.pending[id] < block.timestamp, "SM: Too early to confirm guardian revokation");
        require(block.timestamp < config.pending[id] + securityWindow, "SM: Too late to confirm guardian revokation");
        guardianStorage.revokeGuardian(_wallet, _guardian);
        emit GuardianRevoked(_wallet, _guardian);
        delete config.pending[id];
    }

    /**
     * @notice Lets the owner cancel a pending guardian revokation.
     * @param _wallet The target wallet.
     * @param _guardian The guardian.
     */
    function cancelGuardianRevokation(address _wallet, address _guardian) external onlyWalletOwnerOrSelf(_wallet) onlyWhenUnlocked(_wallet) {
        bytes32 id = keccak256(abi.encodePacked(_wallet, _guardian, "revokation"));
        GuardianManagerConfig storage config = guardianConfigs[_wallet];
        require(config.pending[id] > 0, "SM: no pending guardian revokation for target");
        delete config.pending[id];
        emit GuardianRevokationCancelled(_wallet, _guardian);
    }

    /**
     * @notice Checks if an address is a guardian for a wallet.
     * @param _wallet The target wallet.
     * @param _guardian The address to check.
     * @return _isGuardian `true` if the address is a guardian for the wallet otherwise `false`.
     */
    function isGuardian(address _wallet, address _guardian) public view returns (bool _isGuardian) {
        _isGuardian = guardianStorage.isGuardian(_wallet, _guardian);
    }

    /**
    * @notice Checks if an address is a guardian or an account authorised to sign on behalf of a smart-contract guardian.
    * @param _wallet The target wallet.
    * @param _guardian the address to test
    * @return _isGuardian `true` if the address is a guardian for the wallet otherwise `false`.
    */
    function isGuardianOrGuardianSigner(address _wallet, address _guardian) external view returns (bool _isGuardian) {
        (_isGuardian, ) = GuardianUtils.isGuardianOrGuardianSigner(guardianStorage.getGuardians(_wallet), _guardian);
    }

    /**
     * @notice Counts the number of active guardians for a wallet.
     * @param _wallet The target wallet.
     * @return _count The number of active guardians for a wallet.
     */
    function guardianCount(address _wallet) external view returns (uint256 _count) {
        return guardianStorage.guardianCount(_wallet);
    }

    /**
     * @notice Get the active guardians for a wallet.
     * @param _wallet The target wallet.
     * @return _guardians the active guardians for a wallet.
     */
    function getGuardians(address _wallet) external view returns (address[] memory _guardians) {
        return guardianStorage.getGuardians(_wallet);
    }

    // *************** Internal Functions ********************* //

    function validateNewOwner(address _wallet, address _newOwner) internal view {
        require(_newOwner != address(0), "SM: new owner address cannot be null");
        require(!guardianStorage.isGuardian(_wallet, _newOwner), "SM: new owner address cannot be a guardian");
    }

    function setLock(address _wallet, uint256 _releaseAfter) internal {
        lockStorage.setLock(_wallet, address(this), _releaseAfter);
    }
}