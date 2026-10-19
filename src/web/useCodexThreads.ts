import { useEffect, useRef, useState } from 'react';
import type { CodexThread, DashboardState } from '../shared/types';
import { errorText, ReleApi } from './client';

export function useCodexThreads(
  api: ReleApi,
  state: DashboardState,
  includeArchived = false,
) {
  const connected = state.codex.connected;
  const key = JSON.stringify([
    state.config.codex,
    connected,
    state.codex.executable,
    state.codex.transport,
    state.codex.endpoint,
    state.codex.codexHome,
    state.codex.name,
    includeArchived,
  ]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    threads: CodexThread[];
    loading: boolean;
    error: string;
  }>({ key: '', threads: [], loading: connected, error: '' });
  const request = useRef<AbortController | null>(null);
  const fullRefresh = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = fullRefresh.current;
    fullRefresh.current = false;
    request.current = controller;
    setResult({ key, threads: [], loading: connected, error: '' });
    if (connected) {
      void Promise.allSettled(
        (includeArchived ? [false, true] : [false]).map(async (archived) => {
          const page = await api.request<{ threads: CodexThread[] }>(
            `/api/threads?archived=${archived}${refresh ? '&refresh=true' : ''}`,
            'GET',
            undefined,
            controller.signal,
          );
          return page.threads.map((thread) => ({ ...thread, archived }));
        }),
      ).then((pages) => {
        if (controller.signal.aborted) return;
        setResult({
          key,
          threads: pages.flatMap((page) =>
            page.status === 'fulfilled' ? page.value : [],
          ),
          loading: false,
          error: pages
            .flatMap((page) =>
              page.status === 'rejected' ? [errorText(page.reason)] : [],
            )
            .join(' '),
        });
      });
    }
    return () => controller.abort();
  }, [api, connected, key, includeArchived, revision]);

  const current =
    result.key === key
      ? result
      : { threads: [], loading: connected, error: '' };
  return {
    ...current,
    ready: connected && !current.loading && !current.error,
    reload: (refresh = false) => {
      fullRefresh.current = refresh;
      request.current?.abort();
      setResult({ key, threads: [], loading: connected, error: '' });
      setRevision((value) => value + 1);
    },
  };
}
