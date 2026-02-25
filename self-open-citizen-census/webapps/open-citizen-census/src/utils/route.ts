import { isValidProcessId, normalizeProcessId } from './normalization';
import type { RouteContext } from '../types/state';

export function parseRouteFromPath(pathname: string): RouteContext {
  const logicalPath = String(pathname || '/').trim() || '/';

  if (logicalPath === '/' || logicalPath === '/create') {
    return {
      name: 'create',
      processId: '',
      contextPresent: false,
      contextValid: false,
    };
  }

  if (logicalPath === '/vote' || logicalPath === '/vote/') {
    return {
      name: 'vote',
      processId: '',
      contextPresent: false,
      contextValid: false,
    };
  }

  if (logicalPath.startsWith('/vote/')) {
    const rawSegment = decodeURIComponent(logicalPath.slice('/vote/'.length)).trim();
    const normalized = normalizeProcessId(rawSegment);
    const valid = isValidProcessId(normalized);
    return {
      name: 'vote',
      processId: valid ? normalized : '',
      contextPresent: Boolean(rawSegment),
      contextValid: valid,
    };
  }

  return {
    name: 'create',
    processId: '',
    contextPresent: false,
    contextValid: false,
  };
}
