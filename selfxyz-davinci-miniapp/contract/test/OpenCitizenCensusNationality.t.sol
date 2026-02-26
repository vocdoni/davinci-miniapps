// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {OpenCitizenCensus} from "../src/OpenCitizenCensus.sol";

contract OpenCitizenCensusHarness is OpenCitizenCensus {
    constructor(
        address identityVerificationHubAddress,
        string memory scopeSeed,
        bytes32 configId,
        string[] memory targetNationalitiesAlpha3,
        uint256 minAge_
    )
        OpenCitizenCensus(
            identityVerificationHubAddress,
            scopeSeed,
            configId,
            targetNationalitiesAlpha3,
            minAge_
        )
    {}

    function isAllowedNationalityForTest(
        string memory nationality
    ) external view returns (bool) {
        return _isAllowedNationality(nationality);
    }
}

contract OpenCitizenCensusNationalityTest is Test {
    address internal constant HUB = address(0x1001);
    bytes32 internal constant CONFIG_ID = bytes32(uint256(1));
    string internal constant SCOPE = "USA_18_abcde";

    function _deploy(
        string[] memory countries
    ) internal returns (OpenCitizenCensusHarness) {
        return new OpenCitizenCensusHarness(HUB, SCOPE, CONFIG_ID, countries, 18);
    }

    function testConstructorRejectsEmptyNationalityList() public {
        string[] memory countries = new string[](0);

        vm.expectRevert(OpenCitizenCensus.InvalidNationalityList.selector);
        _deploy(countries);
    }

    function testConstructorRejectsMoreThanFiveNationalities() public {
        string[] memory countries = new string[](6);
        countries[0] = "USA";
        countries[1] = "FRA";
        countries[2] = "ESP";
        countries[3] = "DEU";
        countries[4] = "ITA";
        countries[5] = "GBR";

        vm.expectRevert(OpenCitizenCensus.InvalidNationalityList.selector);
        _deploy(countries);
    }

    function testConstructorRejectsDuplicateNationalities() public {
        string[] memory countries = new string[](2);
        countries[0] = "USA";
        countries[1] = "USA";

        vm.expectRevert(OpenCitizenCensus.DuplicateNationality.selector);
        _deploy(countries);
    }

    function testConstructorRejectsEmptyNationalityEntry() public {
        string[] memory countries = new string[](2);
        countries[0] = "USA";
        countries[1] = "";

        vm.expectRevert(OpenCitizenCensus.InvalidNationalityList.selector);
        _deploy(countries);
    }

    function testNationalityAllowListUsesOrSemantics() public {
        string[] memory countries = new string[](2);
        countries[0] = "USA";
        countries[1] = "FRA";

        OpenCitizenCensusHarness census = _deploy(countries);

        assertTrue(census.isAllowedNationalityForTest("USA"));
        assertTrue(census.isAllowedNationalityForTest("FRA"));
        assertFalse(census.isAllowedNationalityForTest("ESP"));
    }
}
