// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// Self (V2)
import {
    ISelfVerificationRoot
} from "@selfxyz/contracts/contracts/interfaces/ISelfVerificationRoot.sol";
import {
    SelfVerificationRoot
} from "@selfxyz/contracts/contracts/abstract/SelfVerificationRoot.sol";

// zk-kit Lean-IMT
import {
    InternalLeanIMT,
    LeanIMTData
} from "zk-kit.solidity/packages/lean-imt/contracts/InternalLeanIMT.sol";

import {
    ICensusValidator
} from "davinci-contracts/src/interfaces/ICensusValidator.sol";

/// @notice Self.xyz-gated registry that builds a Lean-IMT census and exposes ICensusValidator.
contract OpenCitizenCensus is ICensusValidator, SelfVerificationRoot, Ownable {
    using InternalLeanIMT for LeanIMTData;

    uint256 private constant MAX_NATIONALITIES = 5;

    // ====================================================
    // Self config
    // ====================================================
    bytes32 public verificationConfigId;

    bytes32[] private _targetNationalityHashes;
    mapping(bytes32 nationalityHash => bool allowed) private _allowedNationalityHash;
    uint256 public immutable minAge;

    // ====================================================
    // Census / weights
    // ====================================================
    LeanIMTData private _tree;

    mapping(address => uint88) public weightOf;

    /// @notice One-real-person-only: prevent multiple registrations even across different addresses and documents.
    mapping(uint256 nullifier => bool used) public nullifierUsed;

    // ====================================================
    // Root history (circular buffer of last 100 replaced roots)
    // ====================================================
    uint256 private constant ROOT_HISTORY_SIZE = 100;

    uint256 private _currentRoot;

    uint256[ROOT_HISTORY_SIZE] private _historyRoots;
    uint256[ROOT_HISTORY_SIZE] private _historyLastValidBlock;
    uint256 private _historyIndex;

    mapping(uint256 root => uint256 lastValidBlock) private _rootLastValidBlock;

    // ====================================================
    // Events / Errors
    // ====================================================
    event Registered(
        address indexed user,
        uint256 indexed nullifier,
        uint256 leaf,
        uint256 newRoot
    );

    error NotAdult();
    error WrongNationality();
    error InvalidNationalityList();
    error DuplicateNationality();
    error AlreadyRegisteredAddress();
    error NullifierAlreadyUsed();

    /// @param identityVerificationHubAddress IdentityVerificationHub V2 (proxy) address
    /// @param scopeSeed Short string (<=31 bytes recommended). Used to compute the on-chain scope.
    /// @param configId Verification config id known by the hub
    /// @param targetNationalitiesAlpha3 ISO-3166-1 alpha-2/3 list, e.g. ["ESP", "FRA"]
    /// @param minAge_ Minimum age required for registration
    constructor(
        address identityVerificationHubAddress,
        string memory scopeSeed,
        bytes32 configId,
        string[] memory targetNationalitiesAlpha3,
        uint256 minAge_
    )
        SelfVerificationRoot(identityVerificationHubAddress, scopeSeed)
        Ownable(_msgSender())
    {
        uint256 totalNationalities = targetNationalitiesAlpha3.length;
        if (totalNationalities == 0 || totalNationalities > MAX_NATIONALITIES) {
            revert InvalidNationalityList();
        }
        for (uint256 i = 0; i < totalNationalities; i++) {
            string memory nationality = targetNationalitiesAlpha3[i];
            bytes memory nationalityBytes = bytes(nationality);
            if (nationalityBytes.length == 0) revert InvalidNationalityList();

            bytes32 nationalityHash = keccak256(nationalityBytes);
            if (_allowedNationalityHash[nationalityHash]) revert DuplicateNationality();

            _allowedNationalityHash[nationalityHash] = true;
            _targetNationalityHashes.push(nationalityHash);
        }

        verificationConfigId = configId;
        minAge = minAge_;
        _currentRoot = _tree._root();
    }

    // ====================================================
    // ICensusValidator
    // ====================================================

    function getRootBlockNumber(
        uint256 root
    ) external view override returns (uint256 blockNumber) {
        if (root == 0) return 0;
        if (root == _currentRoot) return block.number;
        return _rootLastValidBlock[root];
    }

    function getCensusRoot() external view override returns (uint256 root) {
        return _currentRoot;
    }

    // ====================================================
    // Admin
    // ====================================================

    function setConfigId(bytes32 configId) external onlyOwner {
        verificationConfigId = configId;
    }

    // ====================================================
    // SelfVerificationRoot overrides
    // ====================================================

    function getConfigId(
        bytes32 /* destinationChainId */,
        bytes32 /* userIdentifier */,
        bytes memory /* userDefinedData */
    ) public view override returns (bytes32) {
        return verificationConfigId;
    }

    function customVerificationHook(
        ISelfVerificationRoot.GenericDiscloseOutputV2 memory output,
        bytes memory /* userData */
    ) internal override {
        // Address bound to proof (userIdentifier low 160 bits)
        address user = address(uint160(output.userIdentifier));
        if (user == address(0)) revert AlreadyRegisteredAddress(); // simplest non-zero guard

        // Hard requirements
        if (output.olderThan < minAge) revert NotAdult();
        if (!_isAllowedNationality(output.nationality)) revert WrongNationality();

        // One address only (optional but usually desired)
        if (weightOf[user] != 0) revert AlreadyRegisteredAddress();

        // One real person only (the key invariant you requested)
        if (nullifierUsed[output.nullifier]) revert NullifierAlreadyUsed();
        nullifierUsed[output.nullifier] = true;

        // Insert leaf into Lean-IMT
        uint256 leaf = uint256(uint160(user));
        uint256 newRoot = _insertAndRotateRoot(leaf);

        uint88 prev = weightOf[user];
        weightOf[user] = 1;
        emit WeightChanged(user, prev, 1);

        emit Registered(user, output.nullifier, leaf, newRoot);
    }

    // ====================================================
    // Internal: root rotation
    // ====================================================

    function _insertAndRotateRoot(
        uint256 leaf
    ) internal returns (uint256 newRoot) {
        newRoot = _tree._insert(leaf);

        uint256 oldRoot = _currentRoot;
        if (oldRoot != 0 && oldRoot != newRoot) {
            uint256 lastValidBlock = block.number;

            uint256 evictedRoot = _historyRoots[_historyIndex];
            if (evictedRoot != 0) {
                delete _rootLastValidBlock[evictedRoot];
            }

            _historyRoots[_historyIndex] = oldRoot;
            _historyLastValidBlock[_historyIndex] = lastValidBlock;
            _rootLastValidBlock[oldRoot] = lastValidBlock;

            _historyIndex = (_historyIndex + 1) % ROOT_HISTORY_SIZE;
        }

        _currentRoot = newRoot;
    }

    // Convenience getters
    function treeSize() external view returns (uint256) {
        return _tree.size;
    }
    function treeDepth() external view returns (uint256) {
        return _tree.depth;
    }
    function leafOf(address user) external pure returns (uint256) {
        return uint256(uint160(user));
    }

    function targetNationalityHashesLength() external view returns (uint256) {
        return _targetNationalityHashes.length;
    }

    function targetNationalityHashAt(uint256 index) external view returns (bytes32) {
        return _targetNationalityHashes[index];
    }

    function _isAllowedNationality(
        string memory nationality
    ) internal view returns (bool) {
        return _allowedNationalityHash[keccak256(bytes(nationality))];
    }
}
