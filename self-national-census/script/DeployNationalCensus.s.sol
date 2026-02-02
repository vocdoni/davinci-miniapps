// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {IIdentityVerificationHubV2} from "@selfxyz/contracts/contracts/interfaces/IIdentityVerificationHubV2.sol";
import {SelfStructs} from "@selfxyz/contracts/contracts/libraries/SelfStructs.sol";
import {SelfUtils} from "@selfxyz/contracts/contracts/libraries/SelfUtils.sol";

import {NationalCensus} from "../src/NationalCensus.sol";

contract DeployNationalCensus is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address hubAddress = vm.envAddress("HUB_ADDRESS");
        string memory scopeSeed = vm.envString("SCOPE_SEED");
        string memory nationality = vm.envString("NATIONALITY");
        uint256 minAge = vm.envUint("MIN_AGE");
        uint256 registerConfigRaw = vm.envOr("SELF_REGISTER_CONFIG", uint256(0));
        bool registerConfig = registerConfigRaw == 1;
        uint256 configMinAge = vm.envOr("SELF_MIN_AGE", minAge);
        uint256 ofacEnabledRaw = vm.envOr("SELF_OFAC_ENABLED", uint256(0));
        bool ofacEnabled = ofacEnabledRaw == 1;
        string memory forbiddenCsv = vm.envOr("SELF_FORBIDDEN_COUNTRIES", string(""));
        bytes32 configId = bytes32(0);

        console2.log("Deploying NationalCensus...");
        console2.log("Hub:", hubAddress);
        console2.log("Scope seed:", scopeSeed);
        console2.log("Nationality:", nationality);
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

        NationalCensus census = new NationalCensus(
            hubAddress,
            scopeSeed,
            configId,
            nationality,
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

    function _bytesToString(bytes memory buffer, uint256 length) private pure returns (string memory) {
        bytes memory trimmed = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            trimmed[i] = buffer[i];
        }
        return string(trimmed);
    }
}
