// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {IIdentityVerificationHubV2} from "@selfxyz/contracts/contracts/interfaces/IIdentityVerificationHubV2.sol";
import {SelfStructs} from "@selfxyz/contracts/contracts/libraries/SelfStructs.sol";
import {SelfUtils} from "@selfxyz/contracts/contracts/libraries/SelfUtils.sol";

import {OpenCitizenCensus} from "../src/OpenCitizenCensus.sol";

contract DeployOpenCitizenCensus is Script {
    uint256 private constant MAX_NATIONALITIES = 5;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address hubAddress = vm.envAddress("HUB_ADDRESS");
        string memory scopeSeed = vm.envString("SCOPE_SEED");
        string[] memory nationalities = _readTargetNationalities();
        uint256 minAge = vm.envUint("MIN_AGE");
        uint256 registerConfigRaw = vm.envOr("SELF_REGISTER_CONFIG", uint256(0));
        bool registerConfig = registerConfigRaw == 1;
        uint256 configMinAge = vm.envOr("SELF_MIN_AGE", minAge);
        uint256 ofacEnabledRaw = vm.envOr("SELF_OFAC_ENABLED", uint256(0));
        bool ofacEnabled = ofacEnabledRaw == 1;
        string memory forbiddenCsv = vm.envOr("SELF_FORBIDDEN_COUNTRIES", string(""));
        bytes32 configId = bytes32(0);

        console2.log("Deploying OpenCitizenCensus...");
        console2.log("Hub:", hubAddress);
        console2.log("Scope seed:", scopeSeed);
        console2.log("Nationalities count:", nationalities.length);
        for (uint256 i = 0; i < nationalities.length; i++) {
            console2.log(" -", nationalities[i]);
        }
        console2.log("Min age:", minAge);
        console2.log("Register config:", registerConfig);
        console2.log("Config min age:", configMinAge);
        console2.log("Config OFAC:", ofacEnabled);

        vm.startBroadcast(deployerPrivateKey);

        if (registerConfig) {
            SelfUtils.UnformattedVerificationConfigV2 memory unformatted;
            unformatted.olderThan = configMinAge;
            unformatted.ofacEnabled = ofacEnabled;
            unformatted.forbiddenCountries = _parseForbiddenCountries(forbiddenCsv);

            SelfStructs.VerificationConfigV2 memory formatted = SelfUtils.formatVerificationConfigV2(unformatted);
            configId = IIdentityVerificationHubV2(hubAddress).setVerificationConfigV2(formatted);
            console2.log("Registered configId:");
            console2.logBytes32(configId);
        } else {
            configId = vm.envBytes32("CONFIG_ID");
        }

        OpenCitizenCensus census = new OpenCitizenCensus(
            hubAddress,
            scopeSeed,
            configId,
            nationalities,
            minAge
        );
        vm.stopBroadcast();

        console2.log("Deployed at:", address(census));
    }

    function _parseForbiddenCountries(
        string memory csv
    ) internal pure returns (string[] memory parsed) {
        bytes memory data = bytes(csv);
        if (data.length == 0) {
            return new string[](0);
        }

        uint256 count = 1;
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] == ",") {
                count++;
            }
        }

        parsed = new string[](count);
        bytes memory buffer = new bytes(data.length);
        uint256 bufLen;
        uint256 idx;
        for (uint256 i = 0; i < data.length; i++) {
            bytes1 char = data[i];
            if (char == ",") {
                parsed[idx++] = _bytesToString(buffer, bufLen);
                bufLen = 0;
            } else if (char != " " && char != "\t") {
                buffer[bufLen++] = char;
            }
        }
        parsed[idx] = _bytesToString(buffer, bufLen);
    }

    function _readTargetNationalities() internal view returns (string[] memory normalized) {
        string memory rawNationalities = vm.envOr("NATIONALITIES", string(""));
        string[] memory parsed = bytes(rawNationalities).length > 0
            ? _parseForbiddenCountries(rawNationalities)
            : _singleItemArray(vm.envString("NATIONALITY"));

        uint256 parsedLength = parsed.length;
        if (parsedLength == 0) revert("At least one nationality is required");
        if (parsedLength > MAX_NATIONALITIES) {
            revert("Too many nationalities. Max 5");
        }

        normalized = new string[](parsedLength);
        uint256 total;
        for (uint256 i = 0; i < parsedLength; i++) {
            string memory country = _normalizeCountryCode(parsed[i]);
            bytes32 hash = keccak256(bytes(country));
            for (uint256 j = 0; j < total; j++) {
                if (keccak256(bytes(normalized[j])) == hash) {
                    revert("Duplicate nationality");
                }
            }
            normalized[total++] = country;
        }

        if (total == 0) revert("At least one nationality is required");
        if (total > MAX_NATIONALITIES) revert("Too many nationalities. Max 5");
    }

    function _singleItemArray(string memory value) private pure returns (string[] memory values) {
        values = new string[](1);
        values[0] = value;
    }

    function _normalizeCountryCode(string memory value) private pure returns (string memory) {
        bytes memory raw = bytes(value);
        bytes memory tmp = new bytes(raw.length);
        uint256 len;
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];
            if (char == " " || char == "\t" || char == "\n" || char == "\r") continue;
            if (char >= 0x61 && char <= 0x7a) {
                char = bytes1(uint8(char) - 32);
            }
            if (char < 0x41 || char > 0x5a) revert("Nationality must contain only letters");
            tmp[len++] = char;
        }
        if (len < 2 || len > 3) revert("Nationality must be alpha-2 or alpha-3");
        return _bytesToString(tmp, len);
    }

    function _bytesToString(bytes memory buffer, uint256 length) private pure returns (string memory) {
        bytes memory trimmed = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            trimmed[i] = buffer[i];
        }
        return string(trimmed);
    }
}
