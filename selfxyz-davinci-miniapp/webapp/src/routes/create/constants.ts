import { countryCodes } from '@selfxyz/common';
import { COPY } from '../../copy';

export interface CountryOption {
  code: string;
  label: string;
}

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;
export const MAX_NATIONALITIES = 5;
export const SCOPE_RANDOM_LENGTH = 5;
export const SCOPE_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const DEFAULT_MIN_AGE = '18';
export const DEFAULT_DURATION_HOURS = '24';
export const DEFAULT_MAX_VOTERS = '1000000';

export const ELIGIBILITY_TOOLTIP = COPY.createConstants.eligibilityTooltip;

export const COUNTRY_OPTIONS: CountryOption[] = Object.entries(countryCodes).map(([code, label]) => ({
  code,
  label,
}));
