import type { ElectionStatus, VoteStatus } from './types';

export const FOLD_URL = import.meta.env.VITE_DAVINCI_FOLD_URL as string | undefined;
export const ADMIN_JWT = import.meta.env.VITE_ADMIN_JWT as string | undefined;
export const CIRCUIT_URL = import.meta.env.VITE_CIRCUIT_URL as string | undefined;
export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  | string
  | undefined;

export const CENSUS_ORIGIN_OFFCHAIN_STATIC = 1;

export const VOTE_POLL_INTERVAL_MS = 4000;
export const ELECTION_POLL_INTERVAL_MS = 10000;

export function electionStatusLabel(status: ElectionStatus): string {
  switch (status) {
    case 'created':
      return 'Created';
    case 'active':
      return 'Active';
    case 'ended':
      return 'Ended';
    case 'decrypting':
      return 'Decrypting';
    case 'finalizing':
      return 'Finalizing';
    case 'results':
      return 'Results';
    case 'paused':
      return 'Paused';
    case 'canceled':
      return 'Canceled';
    default:
      return 'Unknown';
  }
}

export function electionStatusColor(status: ElectionStatus): string {
  switch (status) {
    case 'active':
      return 'green';
    case 'created':
      return 'blue';
    case 'ended':
    case 'decrypting':
    case 'finalizing':
      return 'yellow';
    case 'results':
      return 'blue';
    case 'paused':
      return 'orange';
    case 'canceled':
      return 'red';
    default:
      return 'muted';
  }
}

export function voteStatusLabel(status: VoteStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'batched':
      return 'Batched';
    case 'folded':
      return 'Folded';
    case 'settled':
      return 'Settled';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}

export function isElectionAcceptingVotes(status: ElectionStatus): boolean {
  return status === 'active';
}

export function isElectionTerminal(status: ElectionStatus): boolean {
  return status === 'results' || status === 'canceled';
}

export function electionHasResults(status: ElectionStatus): boolean {
  return status === 'results';
}

export function formatEndTime(endTime: string | undefined): string {
  if (!endTime) return 'No end time set';
  const d = new Date(endTime);
  if (isNaN(d.getTime())) return endTime;
  return d.toLocaleString();
}

export function timeUntil(endTime: string | undefined): string {
  if (!endTime) return '';
  const ms = new Date(endTime).getTime() - Date.now();
  if (ms <= 0) return 'Ended';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

const ELECTION_META_KEY_PREFIX = 'dfm_meta_';
const CENSUS_TREE_KEY_PREFIX = 'dfm_census_';

export function saveElectionMeta(
  electionId: string,
  meta: { title: string; description: string; options: string[] }
): void {
  try {
    localStorage.setItem(ELECTION_META_KEY_PREFIX + electionId, JSON.stringify(meta));
  } catch {
    // ignore storage errors
  }
}

export function loadElectionMeta(
  electionId: string
): { title: string; description: string; options: string[] } | null {
  try {
    const raw = localStorage.getItem(ELECTION_META_KEY_PREFIX + electionId);
    if (!raw) return null;
    return JSON.parse(raw) as { title: string; description: string; options: string[] };
  } catch {
    return null;
  }
}

export function saveCensusTree(electionId: string, addresses: string[]): void {
  try {
    localStorage.setItem(CENSUS_TREE_KEY_PREFIX + electionId, JSON.stringify(addresses));
  } catch {
    // ignore storage errors
  }
}

export function loadCensusTree(electionId: string): string[] | null {
  try {
    const raw = localStorage.getItem(CENSUS_TREE_KEY_PREFIX + electionId);
    if (!raw) return null;
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

export function shortHex(hex: string, chars = 8): string {
  if (hex.length <= chars * 2 + 2) return hex;
  return `${hex.slice(0, chars + 2)}…${hex.slice(-chars)}`;
}

export function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

export function parseAddressList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
