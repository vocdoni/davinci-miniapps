// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

// Self (V2)
import {
    ISelfVerificationRoot
} from "@selfxyz/contracts/contracts/interfaces/ISelfVerificationRoot.sol";
import {
    SelfVerificationRoot
} from "@selfxyz/contracts/contracts/abstract/SelfVerificationRoot.sol";

import {
    OnchainCensus
} from "davinci-onchain-census-contract/src/OnchainCensus.sol";

/// @notice Self.xyz-gated registry that builds a Lean-IMT census and exposes ICensusValidator.
contract OpenCitizenCensus is OnchainCensus, SelfVerificationRoot {
    uint256 private constant MAX_NATIONALITIES = 5;

    // ====================================================
    // Self config
    // ====================================================
    bytes32 public verificationConfigId;

    bytes32[] private _targetNationalityHashes;
    mapping(bytes32 nationalityHash => bool allowed) private _allowedNationalityHash;
    uint256 public immutable minAge;

    /// @notice One-real-person-only: prevent multiple registrations even across different addresses and documents.
    mapping(uint256 nullifier => bool used) public nullifierUsed;

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
        address user = address(uint160(output.userIdentifier));

        if (output.olderThan < minAge) revert NotAdult();
        if (!_isAllowedNationality(output.nationality)) revert WrongNationality();

        if (nullifierUsed[output.nullifier]) revert NullifierAlreadyUsed();
        nullifierUsed[output.nullifier] = true;

        (uint256 leaf, uint256 newRoot) = _addToCensus(user, 1);

        emit Registered(user, output.nullifier, leaf, newRoot);
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
