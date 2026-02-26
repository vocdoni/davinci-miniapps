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

export const ELIGIBILITY_TOOLTIP =
  'You set the eligibility rules here. Anyone with a modern ID or Passport from most countries can securely vote, as long as they meet your criteria (Countries & Age) and participate during the process duration.';

export const COUNTRY_OPTIONS: CountryOption[] = [
  { code: 'ARG', label: 'Argentina' },
  { code: 'AUS', label: 'Australia' },
  { code: 'AUT', label: 'Austria' },
  { code: 'BEL', label: 'Belgium' },
  { code: 'BRA', label: 'Brazil' },
  { code: 'CAN', label: 'Canada' },
  { code: 'CHE', label: 'Switzerland' },
  { code: 'CHL', label: 'Chile' },
  { code: 'CHN', label: 'China' },
  { code: 'COL', label: 'Colombia' },
  { code: 'CZE', label: 'Czech Republic' },
  { code: 'DEU', label: 'Germany' },
  { code: 'DNK', label: 'Denmark' },
  { code: 'ESP', label: 'Spain' },
  { code: 'EST', label: 'Estonia' },
  { code: 'FIN', label: 'Finland' },
  { code: 'FRA', label: 'France' },
  { code: 'GBR', label: 'United Kingdom' },
  { code: 'GRC', label: 'Greece' },
  { code: 'HUN', label: 'Hungary' },
  { code: 'IND', label: 'India' },
  { code: 'IRL', label: 'Ireland' },
  { code: 'ISL', label: 'Iceland' },
  { code: 'ISR', label: 'Israel' },
  { code: 'ITA', label: 'Italy' },
  { code: 'JPN', label: 'Japan' },
  { code: 'KOR', label: 'South Korea' },
  { code: 'LTU', label: 'Lithuania' },
  { code: 'LUX', label: 'Luxembourg' },
  { code: 'LVA', label: 'Latvia' },
  { code: 'MEX', label: 'Mexico' },
  { code: 'NLD', label: 'Netherlands' },
  { code: 'NOR', label: 'Norway' },
  { code: 'NZL', label: 'New Zealand' },
  { code: 'PER', label: 'Peru' },
  { code: 'POL', label: 'Poland' },
  { code: 'PRT', label: 'Portugal' },
  { code: 'ROU', label: 'Romania' },
  { code: 'SGP', label: 'Singapore' },
  { code: 'SVK', label: 'Slovakia' },
  { code: 'SVN', label: 'Slovenia' },
  { code: 'SWE', label: 'Sweden' },
  { code: 'THA', label: 'Thailand' },
  { code: 'TUR', label: 'Turkey' },
  { code: 'TWN', label: 'Taiwan' },
  { code: 'USA', label: 'United States' },
  { code: 'ZAF', label: 'South Africa' },
];
