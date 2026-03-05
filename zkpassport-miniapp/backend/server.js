import express from "express";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ZKPassport } = require("@zkpassport/sdk");

const app = express();
const BODY_LIMIT = process.env.BODY_LIMIT || "50mb";
const ZKPASSPORT_DOMAIN = (process.env.ZKPASSPORT_DOMAIN || "localhost").trim();
const ZKPASSPORT_SCOPE = (process.env.ZKPASSPORT_SCOPE || "").trim();
const ZKPASSPORT_DEVMODE = process.env.ZKPASSPORT_DEVMODE === "true";
const ZKPASSPORT_VALIDITY = Number(process.env.ZKPASSPORT_VALIDITY || 604800);
const ZKPASSPORT_RPC_URL =
	process.env.ZKPASSPORT_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const FRONTEND_ORIGINS = (
	process.env.FRONTEND_ORIGIN ||
	"http://127.0.0.1:4176,http://localhost:4176"
)
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const isOriginAllowed = (origin) =>
	FRONTEND_ORIGINS.includes("*") || FRONTEND_ORIGINS.includes(origin);

function normalizeBytes32Hex(value) {
	let bigintValue;

	if (typeof value === "bigint") {
		bigintValue = value;
	} else if (typeof value === "string") {
		const raw = value.trim();
		if (raw.length === 0) {
			return null;
		}

		try {
			if (raw.startsWith("0x") || raw.startsWith("0X")) {
				const hex = raw.slice(2);
				if (!/^[0-9a-fA-F]+$/.test(hex)) {
					return null;
				}
				bigintValue = BigInt(`0x${hex}`);
			} else if (/^[0-9]+$/.test(raw)) {
				// SDK may return decimal-string identifiers.
				bigintValue = BigInt(raw);
			} else if (/^[0-9a-fA-F]+$/.test(raw)) {
				bigintValue = BigInt(`0x${raw}`);
			} else {
				return null;
			}
		} catch {
			return null;
		}
	} else {
		return null;
	}

	if (bigintValue < 0n) {
		return null;
	}

	const hex = bigintValue.toString(16);
	if (hex.length > 64) {
		return null;
	}

	return `0x${hex.padStart(64, "0")}`;
}

app.use((req, res, next) => {
	const origin = req.headers.origin;
	if (origin && isOriginAllowed(origin)) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
	}

	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	if (req.method === "OPTIONS") return res.sendStatus(204);
	next();
});

app.use((req, _, next) => {
	console.log(`[backend] ${req.method} ${req.path} origin=${req.headers.origin ?? "-"}`);
	next();
});

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

app.get("/health", (_req, res) => {
	res.json({ success: true });
});

app.post("/verify", async (req, res) => {
	try {
		const { verification } = req.body;
		if (
			!verification ||
			!Array.isArray(verification.proofs) ||
			verification.proofs.length === 0 ||
			!verification.queryResult
		) {
			return res.status(400).json({
				success: false,
				error: "Missing ZKPassport verification data",
			});
		}

		const zkPassport = new ZKPassport(ZKPASSPORT_DOMAIN);

		// Gate 1: verify the full proof bundle with the SDK.
		const { verified, queryResultErrors, uniqueIdentifier } =
			await zkPassport.verify({
				proofs: verification.proofs,
				queryResult: verification.queryResult,
				scope: ZKPASSPORT_SCOPE || undefined,
				validity: Number.isFinite(ZKPASSPORT_VALIDITY) ? ZKPASSPORT_VALIDITY : undefined,
				devMode: ZKPASSPORT_DEVMODE,
			});

		if (!verified) {
			console.error("Verification failed:", queryResultErrors);
			return res.status(400).json({
				success: false,
				error: "Identity verification failed",
				queryResultErrors: queryResultErrors ?? null,
			});
		}

		if (!uniqueIdentifier) {
			return res.status(400).json({
				success: false,
				error: "Could not extract the unique identifier",
			});
		}

		const disclosedNationality =
			typeof verification?.queryResult?.nationality?.disclose?.result === "string"
				? verification.queryResult.nationality.disclose.result
				: null;

		const evmOuterProof = verification.proofs.find(
			(proof) => typeof proof?.name === "string" && proof.name.startsWith("outer_evm_"),
		);

		if (!evmOuterProof) {
			return res.status(400).json({
				success: false,
				error:
					"Missing EVM outer proof. Request must be generated in 'compressed-evm' mode.",
			});
		}

		// Gate 2: run a read-only on-chain verifier check (no tx is sent).
		const solidityParams = zkPassport.getSolidityVerifierParameters({
			proof: evmOuterProof,
			validityPeriodInSeconds: Number.isFinite(ZKPASSPORT_VALIDITY)
				? ZKPASSPORT_VALIDITY
				: 604800,
			domain: ZKPASSPORT_DOMAIN,
			scope: ZKPASSPORT_SCOPE || undefined,
			devMode: ZKPASSPORT_DEVMODE,
		});

		const verifier = zkPassport.getSolidityVerifierDetails();
		const publicClient = createPublicClient({
			chain: sepolia,
			transport: http(ZKPASSPORT_RPC_URL),
		});

		const readResult = await publicClient.readContract({
			address: verifier.address,
			abi: verifier.abi,
			functionName: verifier.functionName,
			args: [solidityParams],
		});

		const evmCheckValid = Array.isArray(readResult) ? Boolean(readResult[0]) : false;
		const evmUniqueIdentifier =
			Array.isArray(readResult) && typeof readResult[1] === "string"
				? readResult[1]
				: null;

		if (!evmCheckValid) {
			return res.status(400).json({
				success: false,
				error: "EVM verifier static check failed",
			});
		}

		const normalizedSdkUniqueIdentifier = normalizeBytes32Hex(uniqueIdentifier);
		const normalizedEvmUniqueIdentifier = normalizeBytes32Hex(evmUniqueIdentifier);
		const uidMismatch =
			normalizedSdkUniqueIdentifier && normalizedEvmUniqueIdentifier
				? normalizedSdkUniqueIdentifier !== normalizedEvmUniqueIdentifier
				: evmUniqueIdentifier
					? evmUniqueIdentifier.toLowerCase() !== uniqueIdentifier.toLowerCase()
					: false;

		if (uidMismatch) {
			return res.status(400).json({
				success: false,
				error: "Unique identifier mismatch between SDK and EVM checks",
				received: {
					sdkUniqueIdentifier: uniqueIdentifier,
					evmUniqueIdentifier,
					normalizedSdkUniqueIdentifier,
					normalizedEvmUniqueIdentifier,
				},
			});
		}

		return res.json({
			uniqueIdentifier,
			nationality: disclosedNationality,
			success: true,
			checks: {
				sdkVerified: true,
				evmStaticCheck: true,
				outerProofName: evmOuterProof.name,
				verifierAddress: verifier.address,
				rpcUrl: ZKPASSPORT_RPC_URL,
			},
		});
	} catch (error) {
		console.error("Registration error:", error);
		res.status(500).json({
			success: false,
			error: "Server error during registration",
		});
	}
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const server = app.listen(PORT, HOST, (error) => {
	if (error) {
		console.error("Failed to start server:", error);
		process.exit(1);
	}
	console.log(`Server running on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
	console.error("Server error:", error);
	process.exit(1);
});
