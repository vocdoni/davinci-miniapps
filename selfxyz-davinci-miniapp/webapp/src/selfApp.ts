const REDIRECT_URL = 'https://redirect.self.xyz';

export function getUniversalLink(selfApp: unknown): string {
  return `${REDIRECT_URL}?selfApp=${encodeURIComponent(JSON.stringify(selfApp))}`;
}
