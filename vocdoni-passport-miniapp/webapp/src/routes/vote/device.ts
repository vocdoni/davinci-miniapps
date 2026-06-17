export const REGISTRATION_MOBILE_BREAKPOINT = 860;
export const REGISTRATION_MOBILE_MEDIA_QUERY = `(max-width: ${REGISTRATION_MOBILE_BREAKPOINT}px)`;
export const REGISTRATION_COARSE_POINTER_QUERY = '(pointer: coarse)';

export function isRegistrationMobileMode(viewportWidth: number, coarsePointer: boolean): boolean {
  return viewportWidth <= REGISTRATION_MOBILE_BREAKPOINT || coarsePointer;
}

export function detectRegistrationMobileMode(
  target:
    | {
        innerWidth?: number;
        matchMedia?: (query: string) => { matches: boolean };
      }
    | null
    | undefined = typeof window !== 'undefined' ? window : undefined
): boolean {
  if (!target) return false;

  const coarsePointer = typeof target.matchMedia === 'function' ? target.matchMedia(REGISTRATION_COARSE_POINTER_QUERY).matches : false;
  const mediaMatch = typeof target.matchMedia === 'function' ? target.matchMedia(REGISTRATION_MOBILE_MEDIA_QUERY).matches : false;
  const viewportWidth = Number.isFinite(target.innerWidth) ? Number(target.innerWidth) : REGISTRATION_MOBILE_BREAKPOINT + 1;

  return mediaMatch || isRegistrationMobileMode(viewportWidth, coarsePointer);
}
