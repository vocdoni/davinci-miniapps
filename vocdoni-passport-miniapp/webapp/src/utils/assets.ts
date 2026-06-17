const DEFAULT_LOGO_ASSET_VERSION = '20260225';

export function buildAssetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const version = import.meta.env.VITE_LOGO_ASSET_VERSION || DEFAULT_LOGO_ASSET_VERSION;
  return `${base.replace(/\/$/, '')}/assets/${file}?v=${encodeURIComponent(version)}`;
}
