export const VOTE_SUBMISSION_STORAGE_PREFIX = 'occ.voteSubmission.v1';

export interface VoteSubmissionSnapshot {
  voteId: string;
  status: string;
}

export function voteSubmissionStorageKey(processId: string, address: string): string {
  const normalizedProcessId = String(processId || '').trim().toLowerCase();
  const normalizedAddress = String(address || '').trim().toLowerCase();
  return `${VOTE_SUBMISSION_STORAGE_PREFIX}.${normalizedProcessId}.${normalizedAddress}`;
}

export function persistJson<T>(key: string, payload: T): void {
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(payload));
}

export function loadJson<T>(key: string): T | null {
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function persistVoteSubmission(processId: string, address: string, payload: VoteSubmissionSnapshot): void {
  const key = voteSubmissionStorageKey(processId, address);
  persistJson(key, payload);
}

export function loadVoteSubmission(processId: string, address: string): VoteSubmissionSnapshot | null {
  const key = voteSubmissionStorageKey(processId, address);
  return loadJson<VoteSubmissionSnapshot>(key);
}
