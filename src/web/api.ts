import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function useApi<T>(url: string, pollMs = 0) {
  const { t } = useI18n();
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [revision, setRevision] = useState(0);
  const currentUrl = useRef(url);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    let requestId = 0;
    currentUrl.current = url;
    setState({ data: null, error: null, loading: true });
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const id = ++requestId;
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new ApiError(response.status === 404 ? t('We could not find this record.') : t('We could not load the data right now.'), response.status);
        const data = await response.json() as T;
        if (!disposed && id === requestId) setState({ data, error: null, loading: false });
      } catch (error) {
        if (disposed || id !== requestId || (error instanceof Error && error.name === 'AbortError')) return;
        const failure = error instanceof ApiError ? error : new ApiError(t('Could not reach the server. Check your connection and try again.'), 0);
        setState(previous => ({ ...previous, error: failure, loading: false }));
      }
    };
    void load();
    const interval = pollMs > 0 ? window.setInterval(() => void load(), pollMs) : undefined;
    return () => { disposed = true; controller?.abort(); if (interval !== undefined) window.clearInterval(interval); };
  }, [url, revision, pollMs, t]);

  // Never render results belonging to the previous filter or profile.
  if (currentUrl.current !== url) return { data: null, error: null, loading: true, retry };
  return { ...state, retry };
}

export function navigate(path: string) {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

export function useRoute() {
  const read = () => {
    const hash = window.location.hash.replace(/^#\/?/, '') || 'overview';
    const [path, query = ''] = hash.split('?');
    return { path: path.replace(/\/$/, '') || 'overview', query: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const handle = () => setRoute(read());
    window.addEventListener('hashchange', handle);
    return () => window.removeEventListener('hashchange', handle);
  }, []);
  return route;
}

export const percent = (wins: number, matches: number) => matches > 0 ? Math.round(wins / matches * 100) : 0;
