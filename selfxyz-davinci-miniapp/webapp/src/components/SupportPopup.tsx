import { COPY } from '../copy';

interface SupportPopupProps {
  open: boolean;
  onDismiss: () => void;
}

const DISCORD_URL = 'https://chat.vocdoni.io';
const TELEGRAM_URL = 'https://t.me/vocdoni_community';

function SupportLinkIcon({ kind }: { kind: 'discord' | 'telegram' }) {
  if (kind === 'discord') {
    return (
      <svg className="support-popup-link-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M7 9.25h10a3 3 0 0 1 3 3v.5a3 3 0 0 1-3 3h-4.2l-2.4 2.25a.6.6 0 0 1-1.02-.44v-1.8H7a3 3 0 0 1-3-3v-.5a3 3 0 0 1 3-3Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M9.25 12.5h.01M12 12.5h.01M14.75 12.5h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg className="support-popup-link-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 4 11 13"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m20 4-6.5 16-2.8-6.7L4 10 20 4Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function SupportPopup({ open, onDismiss }: SupportPopupProps) {
  return (
    <aside
      className="support-popup card"
      role="dialog"
      aria-modal="false"
      aria-labelledby="supportPopupTitle"
      hidden={!open}
    >
      <button type="button" className="app-popup-close support-popup-close" aria-label={COPY.support.dismiss} onClick={onDismiss}>
        <span aria-hidden="true">×</span>
      </button>

      <p className="eyebrow support-popup-eyebrow">{COPY.support.eyebrow}</p>
      <h2 id="supportPopupTitle" className="support-popup-title">
        {COPY.support.title}
      </h2>
      <p className="support-popup-copy">{COPY.support.description}</p>

      <div className="support-popup-links">
        <a className="support-popup-link" href={DISCORD_URL} target="_blank" rel="noreferrer">
          <SupportLinkIcon kind="discord" />
          {COPY.support.discord}
        </a>
        <a className="support-popup-link support-popup-link-secondary" href={TELEGRAM_URL} target="_blank" rel="noreferrer">
          <SupportLinkIcon kind="telegram" />
          {COPY.support.telegram}
        </a>
      </div>
    </aside>
  );
}
