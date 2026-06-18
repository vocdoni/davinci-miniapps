import { FOLD_URL, ADMIN_JWT } from '../lib/dfc';
import type {
  InfoResponse,
  ElectionResponse,
  ElectionListResponse,
  VoteResponse,
  ResultsResponse,
  WorkerListResponse,
  CreateElectionRequest,
  VoteSubmission,
} from '../lib/types';

function base(): string {
  if (!FOLD_URL) throw new Error('VITE_DAVINCI_FOLD_URL is not set.');
  return FOLD_URL.replace(/\/$/, '');
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(base() + path);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) msg = body.error.message;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown, jwt?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  const res = await fetch(base() + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody.error?.message) msg = errBody.error.message;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const fold = {
  ping(): Promise<void> {
    return fetch(base() + '/ping').then(() => undefined);
  },

  info(): Promise<InfoResponse> {
    return get<InfoResponse>('/info');
  },

  elections(): Promise<ElectionListResponse> {
    return get<ElectionListResponse>('/elections');
  },

  election(id: string): Promise<ElectionResponse> {
    return get<ElectionResponse>(`/elections/${id}`);
  },

  vote(electionId: string, voteId: string): Promise<VoteResponse> {
    return get<VoteResponse>(`/elections/${electionId}/votes/${voteId}`);
  },

  results(electionId: string): Promise<ResultsResponse> {
    return get<ResultsResponse>(`/elections/${electionId}/results`);
  },

  workers(): Promise<WorkerListResponse> {
    return get<WorkerListResponse>('/workers');
  },

  createElection(body: CreateElectionRequest): Promise<ElectionResponse> {
    if (!ADMIN_JWT) throw new Error('VITE_ADMIN_JWT is not set.');
    return post<ElectionResponse>('/elections', body, ADMIN_JWT);
  },

  submitVote(electionId: string, body: VoteSubmission): Promise<VoteResponse> {
    return post<VoteResponse>(`/elections/${electionId}/votes`, body);
  },
};
