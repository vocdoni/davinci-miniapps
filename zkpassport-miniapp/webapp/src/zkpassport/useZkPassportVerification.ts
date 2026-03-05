import { ZKPassport } from "@zkpassport/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type VerificationStatus =
	| "idle"
	| "initiating"
	| "awaiting_scan"
	| "request_received"
	| "generating_proof"
	| "proof_generated"
	| "sending_to_server"
	| "success"
	| "failed"
	| "rejected"
	| "error";

type VerificationResult = {
	verified: boolean;
	result: unknown;
};

type ProofCallbackValue = unknown;
type ProofWithTotal = {
	total?: number;
	name?: string;
};

const APP_NAME = "Ask The World - DAVINCI";
const APP_PURPOSE = "Citizenship Verification";
const APP_LOGO_URL =
	"https://asktheworld.davinci.ninja/assets/davinci_logo.png?v=20260225";
const PROOF_MODE = "compressed-evm";
const BACKEND_URL =
	(import.meta.env.VITE_BACKEND_URL as string | undefined) ??
	"http://127.0.0.1:3000";
const SEND_ON_UNVERIFIED =
	(import.meta.env.VITE_SEND_ON_UNVERIFIED as string | undefined) === "true";
const ZKPASSPORT_DOMAIN =
	(import.meta.env.VITE_ZKPASSPORT_DOMAIN as string | undefined) ?? "localhost";
const ZKPASSPORT_SCOPE =
	(import.meta.env.VITE_ZKPASSPORT_SCOPE as string | undefined)?.trim() || undefined;

const ACTIVE_STATUSES: VerificationStatus[] = [
	"initiating",
	"awaiting_scan",
	"request_received",
	"generating_proof",
	"proof_generated",
	"sending_to_server",
];

function log(message: string, data?: unknown): void {
	console.log("[webapp]", message, data ?? "");
}

function hasOuterEvmProof(proofs: unknown[]): boolean {
	return proofs.some((proof) => {
		const name = (proof as { name?: unknown })?.name;
		return typeof name === "string" && name.startsWith("outer_evm_");
	});
}

export function useZkPassportVerification(): {
	verificationStatus: VerificationStatus;
	verificationUrl: string;
	error: string;
	uniqueIdentifier: string;
	nationality: string;
	canCancel: boolean;
	handleSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
	cancelVerification: () => void;
} {
	const [verificationStatus, setVerificationStatus] =
		useState<VerificationStatus>("idle");
	const [verificationUrl, setVerificationUrl] = useState<string>("");
	const [error, setError] = useState<string>("");
	const [uniqueIdentifier, setUniqueIdentifier] = useState<string>("");
	const [nationality, setNationality] = useState<string>("");
	const [requestId, setRequestId] = useState<string>("");

	const zkpassportRef = useRef<ZKPassport | null>(null);
	const proofsRef = useRef<ProofCallbackValue[]>([]);
	const expectedProofCountRef = useRef<number | null>(null);
	const requestIdRef = useRef<string>("");
	const statusRef = useRef<VerificationStatus>("idle");
	const resultHandledRef = useRef<boolean>(false);
	const resultWatchdogRef = useRef<number | null>(null);
	const fastFallbackTimerRef = useRef<number | null>(null);
	const verifyWrapperInstalledRef = useRef<boolean>(false);

	const canCancel = useMemo(
		() => ACTIVE_STATUSES.includes(verificationStatus) && requestId.length > 0,
		[verificationStatus, requestId],
	);

	const setStatus = useCallback((nextStatus: VerificationStatus) => {
		log("Status transition", { from: statusRef.current, to: nextStatus });
		statusRef.current = nextStatus;
		setVerificationStatus(nextStatus);
	}, []);

	const clearTimers = useCallback(() => {
		if (resultWatchdogRef.current !== null) {
			window.clearTimeout(resultWatchdogRef.current);
			resultWatchdogRef.current = null;
		}
		if (fastFallbackTimerRef.current !== null) {
			window.clearTimeout(fastFallbackTimerRef.current);
			fastFallbackTimerRef.current = null;
		}
	}, []);

	const clearUiFlow = useCallback(() => {
		clearTimers();
		setVerificationUrl("");
		setRequestId("");
		requestIdRef.current = "";
		proofsRef.current = [];
		expectedProofCountRef.current = null;
		resultHandledRef.current = false;
	}, [clearTimers]);

	const processVerificationResult = useCallback(
		async ({
			verified,
			queryResult,
			source,
			forceSendToBackend = false,
		}: {
			verified: boolean;
			queryResult: unknown;
			source: string;
			forceSendToBackend?: boolean;
		}) => {
			if (resultHandledRef.current) {
				log("Ignoring duplicate final result", { source });
				return;
			}

			resultHandledRef.current = true;
			clearTimers();
			log("Processing final verification result", {
				source,
				verified,
				proofsCount: proofsRef.current.length,
			});
			setStatus("proof_generated");

			if (!queryResult || typeof queryResult !== "object") {
				setError("Missing final query result from ZKPassport SDK.");
				setStatus("failed");
				return;
			}

			const containsEvmOuterProof = hasOuterEvmProof(proofsRef.current);
			if (!containsEvmOuterProof) {
				setError(
					"Missing outer_evm proof. Ensure request mode is 'compressed-evm'.",
				);
				setStatus("failed");
				return;
			}

			if (!verified && !SEND_ON_UNVERIFIED && !forceSendToBackend) {
				log("Client-side verification failed; delegating final decision to backend");
			}

			try {
				setStatus("sending_to_server");

				const response = await fetch(`${BACKEND_URL}/verify`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						verification: {
							proofs: proofsRef.current,
							queryResult,
						},
					}),
				});

				const rawPayload = await response.text();
				let payload: {
					success?: boolean;
					error?: string;
					uniqueIdentifier?: string;
					unique_identifier?: string;
					nationality?: string | null;
				} = {};

				if (rawPayload) {
					try {
						payload = JSON.parse(rawPayload) as {
							success?: boolean;
							error?: string;
							uniqueIdentifier?: string;
							unique_identifier?: string;
							nationality?: string | null;
						};
					} catch {
						log("Backend response is not JSON", {
							status: response.status,
							bodyPreview: rawPayload.slice(0, 200),
						});
					}
				}

				if (response.ok && payload.success) {
					const returnedUniqueIdentifier =
						payload.uniqueIdentifier ?? payload.unique_identifier ?? "";
					const returnedNationality =
						typeof payload.nationality === "string" ? payload.nationality : "";
					setUniqueIdentifier(returnedUniqueIdentifier);
					setNationality(returnedNationality);
					setStatus("success");
					clearUiFlow();
					return;
				}

				setError(payload.error ?? "Registration failed on backend.");
				setStatus("failed");
			} catch (serverError) {
				const errorText = String(serverError);
				const likelyCors = /failed to fetch/i.test(errorText);
				setError(
					likelyCors
						? `Backend communication failed (${errorText}). This is usually CORS, wrong URL, or backend not running.`
						: `Backend communication failed: ${errorText}`,
				);
				setStatus("failed");
			}
		},
		[clearTimers, clearUiFlow, setStatus],
	);

	const attemptInternalResultFallback = useCallback(
		async (trigger: string) => {
			const sdkInstance = zkpassportRef.current as any;
			const activeRequestId = requestIdRef.current;

			if (!sdkInstance || !activeRequestId) {
				log("Fallback unavailable: missing SDK or requestId", { trigger });
				return;
			}

			const internalQueryResult = sdkInstance.topicToResults?.[
				activeRequestId
			] as unknown;

			if (!internalQueryResult) {
				log("Fallback unavailable: no query result", { trigger });
				return;
			}

			await processVerificationResult({
				verified: false,
				queryResult: internalQueryResult,
				source: `fallback:${trigger}`,
				forceSendToBackend: true,
			});
		},
		[processVerificationResult],
	);

	const triggerFastFallbackIfProofsComplete = useCallback(() => {
		if (resultHandledRef.current) {
			return;
		}

		const expectedProofCount = expectedProofCountRef.current;
		if (
			typeof expectedProofCount !== "number" ||
			expectedProofCount <= 0 ||
			proofsRef.current.length < expectedProofCount
		) {
			return;
		}

		if (fastFallbackTimerRef.current !== null) {
			window.clearTimeout(fastFallbackTimerRef.current);
		}

		fastFallbackTimerRef.current = window.setTimeout(() => {
			if (resultHandledRef.current) {
				return;
			}
			log("Proof total reached, using fallback completion", {
				proofsCount: proofsRef.current.length,
				totalExpected: expectedProofCount,
			});
			void attemptInternalResultFallback("proofs_total_reached");
		}, 1200);
	}, [attemptInternalResultFallback]);

	const armResultWatchdog = useCallback(() => {
		if (resultWatchdogRef.current !== null) {
			window.clearTimeout(resultWatchdogRef.current);
		}

		resultWatchdogRef.current = window.setTimeout(() => {
			if (resultHandledRef.current) {
				return;
			}
			log("Watchdog triggered, trying fallback", {
				status: statusRef.current,
				proofsCount: proofsRef.current.length,
			});
			void attemptInternalResultFallback("watchdog_timeout");
		}, 20000);
	}, [attemptInternalResultFallback]);

	const cancelVerification = useCallback(() => {
		if (requestIdRef.current && zkpassportRef.current) {
			zkpassportRef.current.cancelRequest(requestIdRef.current);
			log("Cancelled request", { requestId: requestIdRef.current });
		}

		setError("");
		setUniqueIdentifier("");
		setNationality("");
		clearUiFlow();
		setStatus("idle");
	}, [clearUiFlow, setStatus]);

	useEffect(() => {
		log("Webapp mounted", {
			backendUrl: BACKEND_URL,
			sendOnUnverified: SEND_ON_UNVERIFIED,
			domain: ZKPASSPORT_DOMAIN,
			scope: ZKPASSPORT_SCOPE ?? null,
		});

		return () => {
			if (requestIdRef.current && zkpassportRef.current) {
				zkpassportRef.current.cancelRequest(requestIdRef.current);
			}
			clearTimers();
			log("Webapp unmounted");
		};
	}, [clearTimers]);

	const handleSubmit = useCallback(
		async (event: React.FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError("");
			setUniqueIdentifier("");
			setNationality("");
			setStatus("initiating");

			resultHandledRef.current = false;
			requestIdRef.current = "";
			expectedProofCountRef.current = null;
			clearTimers();

			try {
				if (!zkpassportRef.current) {
					zkpassportRef.current = new ZKPassport(ZKPASSPORT_DOMAIN);
					log("SDK instance created", { domain: ZKPASSPORT_DOMAIN });
				}

				if (zkpassportRef.current && !verifyWrapperInstalledRef.current) {
					const sdkInstance = zkpassportRef.current as any;
					const originalVerify = sdkInstance.verify.bind(sdkInstance);
					sdkInstance.verify = async (params: unknown): Promise<unknown> => {
						try {
							return await originalVerify(params);
						} catch (verifyError) {
							log("SDK verify threw (wrapped)", { error: String(verifyError) });
							return {
								uniqueIdentifier: undefined,
								uniqueIdentifierType: undefined,
								verified: false,
								queryResultErrors: {
									sdkVerifyException: String(verifyError),
								},
							};
						}
					};
					verifyWrapperInstalledRef.current = true;
				}

				const request = await zkpassportRef.current.request({
					name: APP_NAME,
					logo: APP_LOGO_URL,
					purpose: APP_PURPOSE,
					mode: PROOF_MODE,
					scope: ZKPASSPORT_SCOPE,
				});

				const {
					url,
					requestId: newRequestId,
					onRequestReceived,
					onGeneratingProof,
					onBridgeConnect,
					onProofGenerated,
					onResult,
					onReject,
					onError,
				} = request.disclose("nationality").gte("age", 18).done();

				proofsRef.current = [];
				setVerificationUrl(url);
				setRequestId(newRequestId);
				requestIdRef.current = newRequestId;
				setStatus("awaiting_scan");
				log("Verification URL created", { requestId: newRequestId, url });

				try {
					const proofMode = new URL(url).searchParams.get("m");
					if (proofMode !== PROOF_MODE) {
						log("Unexpected proof mode in request URL", {
							expected: PROOF_MODE,
							received: proofMode,
						});
					}
				} catch {
					// no-op; URL parsing failure should not break verification flow
				}

				onBridgeConnect(() => {
					log("SDK callback: onBridgeConnect");
				});

				onRequestReceived(() => {
					setStatus("request_received");
				});

				onGeneratingProof(() => {
					setStatus("generating_proof");
				});

				onProofGenerated((proof: ProofCallbackValue) => {
					proofsRef.current.push(proof);

					const proofInfo = proof as ProofWithTotal;
					if (typeof proofInfo.total === "number" && proofInfo.total > 0) {
						expectedProofCountRef.current = proofInfo.total;
					}

					log("SDK callback: onProofGenerated", {
						proofsCount: proofsRef.current.length,
						totalExpected: expectedProofCountRef.current,
						name: proofInfo.name ?? null,
					});

					triggerFastFallbackIfProofsComplete();
					armResultWatchdog();
				});

				onResult(
					async ({ verified, result: queryResult }: VerificationResult) => {
						await processVerificationResult({
							verified,
							queryResult,
							source: "sdk:onResult",
						});
					},
				);

				onReject(() => {
					clearTimers();
					setError("Verification request was rejected by the user.");
					setStatus("rejected");
				});

				onError((sdkError: unknown) => {
					clearTimers();
					setError(`SDK error: ${String(sdkError)}`);
					setStatus("error");
				});
			} catch (initError) {
				setError(`Failed to initialize verification: ${String(initError)}`);
				setStatus("error");
			}
		},
		[
			armResultWatchdog,
			clearTimers,
			processVerificationResult,
			setStatus,
			triggerFastFallbackIfProofsComplete,
		],
	);

	return {
		verificationStatus,
		verificationUrl,
		error,
		uniqueIdentifier,
		nationality,
		canCancel,
		handleSubmit,
		cancelVerification,
	};
}
