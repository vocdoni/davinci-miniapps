SHELL := /bin/bash

-include .env.deploy
export

DEPLOY_SCRIPT := script/DeployNationalCensus.s.sol:DeployNationalCensus
POSEIDON_LIB := lib/poseidon-solidity/contracts/PoseidonT3.sol:PoseidonT3:$(POSEIDON_T3)
VERIFIER ?= etherscan
VERIFY ?= 1
CHAIN_ID ?=
VERIFIER_URL ?=
SELF_REGISTER_CONFIG ?= 0

ifeq ($(strip $(VERIFIER_URL)),)
ifneq ($(strip $(CHAIN_ID)),)
VERIFIER_URL := https://api.etherscan.io/v2/api?chainid=$(CHAIN_ID)
endif
endif

ifeq ($(VERIFY),1)
VERIFY_FLAGS := --verify --verifier $(VERIFIER) --verifier-url $(VERIFIER_URL) --etherscan-api-key $(ETHERSCAN_API_KEY)
endif

.PHONY: deploy
deploy:
ifndef RPC_URL
	$(error RPC_URL is required)
endif
ifndef CHAIN_ID
	$(error CHAIN_ID is required)
endif
ifndef PRIVATE_KEY
	$(error PRIVATE_KEY is required)
endif
ifndef HUB_ADDRESS
	$(error HUB_ADDRESS is required)
endif
ifndef POSEIDON_T3
	$(error POSEIDON_T3 is required)
endif
ifndef SCOPE_SEED
	$(error SCOPE_SEED is required)
endif
ifeq ($(SELF_REGISTER_CONFIG),1)
else
ifndef CONFIG_ID
	$(error CONFIG_ID is required when SELF_REGISTER_CONFIG=0)
endif
endif
ifndef NATIONALITY
	$(error NATIONALITY is required)
endif
ifndef MIN_AGE
	$(error MIN_AGE is required)
endif
ifeq ($(VERIFY),1)
ifndef VERIFIER_URL
	$(error VERIFIER_URL is required when VERIFY=1)
endif
ifndef ETHERSCAN_API_KEY
	$(error ETHERSCAN_API_KEY is required when VERIFY=1)
endif
endif
	forge script $(DEPLOY_SCRIPT) \
	  --chain-id $(CHAIN_ID) \
	  --rpc-url $(RPC_URL) \
	  --private-key $(PRIVATE_KEY) \
	  --broadcast \
	  $(VERIFY_FLAGS) \
	  --libraries "$(POSEIDON_LIB)"
