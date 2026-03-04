import express from "express";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ZKPassport } = require("@zkpassport/sdk");

const app = express();
const BODY_LIMIT = process.env.BODY_LIMIT || "50mb";
const FRONTEND_ORIGINS = (
	process.env.FRONTEND_ORIGIN ||
	"http://127.0.0.1:4176,http://localhost:4176"
)
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const isOriginAllowed = (origin) =>
	FRONTEND_ORIGINS.includes("*") || FRONTEND_ORIGINS.includes(origin);

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
		if (!verification || !verification.proofs || !verification.queryResult) {
			return res.status(400).json({
				success: false,
				error: "Missing ZKPassport verification data",
			});
		}

		const zkPassport = new ZKPassport("localhost:8545");

		// Verify the proofs
		const { verified, queryResultErrors, uniqueIdentifier } =
			await zkPassport.verify({
				proofs: verification.proofs,
				queryResult: verification.queryResult,
			});

		if (!verified) {
			console.error("Verification failed:", queryResultErrors);
			return res.status(400).json({
				success: false,
				error: "Identity verification failed",
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

		return res.json({
			uniqueIdentifier,
			nationality: disclosedNationality,
			success: true,
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
