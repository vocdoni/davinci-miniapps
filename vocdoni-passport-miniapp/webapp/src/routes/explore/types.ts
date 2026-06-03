type ExploreFilterReason =
  | 'ok'
  | 'not_listed'
  | 'missing_scope'
  | 'invalid_scope'
  | 'missing_min_age'
  | 'invalid_min_age'
  | 'missing_countries';

export interface ExploreFilterResult {
  accepted: boolean;
  reason: ExploreFilterReason;
}

export interface ExploreProcessRow {
  processId: string;
  questionTitle: string;
  statusCode: number | null;
  statusLabel: string;
  countries: string[];
  minAge: number;
  endDateMs: number | null;
  readyTimeRemainingLabel: string;
  voteHref: string;
  startTimeMs: number;
}

export interface ExplorePageState {
  loading: boolean;
  refreshing: boolean;
  error: string;
  rows: ExploreProcessRow[];
  nextCursor: number;
  hasMore: boolean;
  allProcessIds: string[];
}
