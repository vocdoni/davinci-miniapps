import QRCode from "react-qr-code";
import {
  type VerificationStatus,
  useZkPassportVerification,
} from "./zkpassport/useZkPassportVerification";

function formatStatus(status: VerificationStatus): string {
  if (status === "success") {
    return "Verified by server";
  }

  return status.replace(/_/g, " ");
}

export default function App() {
  const {
    verificationStatus,
    verificationUrl,
    error,
    uniqueIdentifier,
    nationality,
    canCancel,
    handleSubmit,
    cancelVerification,
  } = useZkPassportVerification();

  return (
    <main className="page">
      <section className="card">
        <h1>ZKPassport Verification</h1>
        <p className="subtitle">
          Verify users as 18+ and disclose nationality, then send proofs to the
          backend.
        </p>

        <form onSubmit={handleSubmit} className="form">
          {verificationStatus === "idle" ? (
            <button type="submit" className="primary">
              Start Verification
            </button>
          ) : (
            <>
              <div className="status-line">
                <span className="label">Status</span>
                <span className="value">{formatStatus(verificationStatus)}</span>
              </div>

              {verificationUrl && verificationStatus === "awaiting_scan" ? (
                <div className="qr-section">
                  <p>Scan with ZKPassport:</p>
                  <div className="qr-box">
                    <QRCode value={verificationUrl} size={220} />
                  </div>
                  <a
                    href={verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link"
                  >
                    Open deep link
                  </a>
                </div>
              ) : null}

              {error ? <p className="error">{error}</p> : null}
              {verificationStatus === "success" && nationality ? (
                <div className="status-line">
                  <span className="label">Nationality</span>
                  <span className="value">{nationality}</span>
                </div>
              ) : null}
              {verificationStatus === "success" && uniqueIdentifier ? (
                <div className="status-line status-line--stack">
                  <span className="label">Unique Identifier</span>
                  <span className="value value--identifier">{uniqueIdentifier}</span>
                </div>
              ) : null}

              <div className="actions">
                {canCancel ? (
                  <button type="button" onClick={cancelVerification} className="ghost">
                    Cancel
                  </button>
                ) : null}

                {verificationStatus === "success" ||
                verificationStatus === "failed" ||
                verificationStatus === "rejected" ||
                verificationStatus === "error" ? (
                  <button type="button" onClick={cancelVerification} className="primary">
                    Start Over
                  </button>
                ) : null}
              </div>
            </>
          )}
        </form>
      </section>
    </main>
  );
}
