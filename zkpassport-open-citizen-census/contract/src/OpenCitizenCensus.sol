// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// zk-kit Lean-IMT
import {
    InternalLeanIMT,
    LeanIMTData
} from "zk-kit.solidity/packages/lean-imt/contracts/InternalLeanIMT.sol";

import {
    ICensusValidator
} from "davinci-contracts/src/interfaces/ICensusValidator.sol";

/// @notice Self.xyz-gated registry that builds a Lean-IMT census and exposes ICensusValidator.
contract OpenCitizenCensus is ICensusValidator, Ownable {
    using InternalLeanIMT for LeanIMTData;

    // TODO(contract-plan): replace Self.xyz assumptions with zkPassport verifier + helper dependencies.
    // TODO(contract-plan): add immutable config for `verifier`, `scopeDomain`, `scope`, `requiredCustomData`.
    // TODO(contract-plan): keep `minAge` and add nationality aliases (hash set) instead of single hash only.
    bytes32 public immutable targetNationalityHash;
    uint256 public immutable minAge;

    // Census / weights
    LeanIMTData private _tree;

    mapping(address => uint88) public weightOf;

    /// @notice One-real-person-only: prevent multiple registrations even across different addresses and documents.
    // TODO(contract-plan): migrate from nullifier-based uniqueness to `mapping(bytes32 => bool) uniqueIdentifierUsed`.
    // TODO(contract-plan): keep address-level dedupe as secondary check (`weightOf[voter] != 0`).
    mapping(uint256 nullifier => bool used) public nullifierUsed;

    // Root history (circular buffer of last 100 replaced roots)
    uint256 private constant ROOT_HISTORY_SIZE = 100;

    uint256 private _currentRoot;

    uint256[ROOT_HISTORY_SIZE] private _historyRoots;
    uint256[ROOT_HISTORY_SIZE] private _historyLastValidBlock;
    uint256 private _historyIndex;

    mapping(uint256 root => uint256 lastValidBlock) private _rootLastValidBlock;

    // Events
    // TODO(contract-plan + backend-plan): update event shape to:
    // `Registered(address indexed voter, address indexed sponsor, bytes32 indexed uniqueIdentifier, uint256 leaf, uint256 newRoot)`.
    // TODO(backend-plan): backend post-tx audit depends on voter + sponsor + uniqueIdentifier in emitted event.
    event Registered(
        address indexed user,
        uint256 indexed nullifier,
        uint256 leaf,
        uint256 newRoot
    );

    // Errors
    // TODO(contract-plan): align error set with zkPassport checks:
    // `IdentifierAlreadyUsed`, `InvalidScope`, `InvalidBoundChain`, `InvalidBoundCustomData`.
    // TODO(backend-plan): map deterministic backend errors from these reverts where applicable.
    error NotAdult();
    error WrongNationality();
    error AlreadyRegisteredAddress();
    error NullifierAlreadyUsed();

    // TODO(contract-plan): constructor must receive:
    // 1) `address verifier`
    // 2) `string scopeDomain`
    // 3) `string scope`
    // 4) `string targetNationality`
    // 5) `string[] nationalityAliases`
    // 6) `uint256 minAge`
    // 7) `bytes32 requiredCustomData`
    // TODO(webapp-plan): `scopeDomain` must be set from webapp single env var `VITE_ZKPASSPORT_DOMAIN`.
    // TODO(webapp-plan): deployment flow targets Sepolia; runtime chain check still must use `block.chainid`.
    /// @param scope
    /// @param targetNationality
    /// @param minAge_
    constructor(
        string memory scope,
        string memory targetNationality,
        uint256 minAge_
    )
        Ownable(_msgSender())
    {
        verificationConfigId = configId;
        targetNationalityHash = keccak256(bytes(targetNationality));
        minAge = minAge_;
        _currentRoot = _tree._root();
    }

    // ICensusValidator
    // TODO(contract-plan): keep ICensusValidator compatibility unchanged for onchain-census-indexer tracking.
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

    // TODO(contract-plan + backend-plan): add read helper:
    // `function isUniqueIdentifierRegistered(bytes32 uniqueIdentifier) external view returns (bool)`.
    // TODO(backend-plan): backend must precheck this before sponsoring and confirm true after tx is mined.
    // TODO(webapp-plan): frontend readiness flow depends on backend sponsored tx + indexer reflection, so this helper must be stable.

    // TODO(contract-plan): change entrypoint to sponsored external method:
    // `registerVoter(address voter, ProofVerificationParams calldata proofVerificationParams, bool isIDCard) external`.
    // TODO(contract-plan): `msg.sender` is sponsor/relayer; `voter` is the address inserted as leaf.
    // TODO(contract-plan): `isIDCard` selects proof circuit variant (passport=false, idcard=true).
    function registerVoter(
        /* TODO */
    ) internal override {
        // TODO(contract-plan): execute checks in order:
        // 1) require `voter != address(0)`.
        // 2) revert if `weightOf[voter] != 0`.
        // 3) call zkPassport verifier `verify(proofVerificationParams, isIDCard)`.
        // 4) enforce scope with helper `verifyScopes(publicInputs, scopeDomain, scope)`.
        // 5) enforce bound data with helper `getBoundData(publicInputs)`:
        //    - `destinationChainID == bytes32(block.chainid)`
        //    - `customData == requiredCustomData`
        // 6) enforce age `minimumAge >= minAge`.
        // 7) enforce nationality in configured allowed hashes (target + aliases).
        // 8) enforce UID uniqueness: `!uniqueIdentifierUsed[uid]`, then mark as used.
        // 9) compute leaf `uint256(uint160(voter))`, insert/rotate root, set `weightOf[voter] = 1`.
        // 10) emit `WeightChanged` and `Registered(voter, msg.sender, uid, leaf, newRoot)`.
        // TODO(backend-plan): on failure path, tx must revert so backend returns `INVALID_PROOF` / `ALREADY_REGISTERED_UNIQUE_IDENTIFIER`.
        // TODO(webapp-plan): success path must allow frontend to track tx hash and eventually observe indexer inclusion.
    }

    // Internal: root rotation
    // TODO(contract-plan): keep root rotation behavior and history validity unchanged; tests must cover replacement window behavior.
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
}
