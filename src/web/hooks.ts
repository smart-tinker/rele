import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardState } from '../shared/types';
import { errorText, ReleApi } from './api';

export function useDashboard(api: ReleApi) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await api.state(controller.signal);
      if (active.current && !controller.signal.aborted) { setState(next); setError(''); }
    } catch (cause) {
      if (active.current && !controller.signal.aborted) setError(errorText(cause));
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current && !controller.signal.aborted) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    active.current = true;
    setState(null); setLoading(true); setError('');
    void refresh();
    const onVisible = () => { if (!document.hidden && !request.current) void refresh(); };
    const timer = window.setInterval(onVisible, 4000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active.current = false;
      request.current?.abort(); request.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { state, error, loading, refresh };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const pending = useRef(false);
  const run = async <T,>(task: () => Promise<T>, message = ''): Promise<{ ok: true; value: T } | { ok: false }> => {
    if (pending.current) return { ok: false };
    pending.current = true; setBusy(true); setError(''); setSuccess('');
    try { const value = await task(); setSuccess(message); return { ok: true, value }; }
    catch (cause) { setError(errorText(cause)); return { ok: false }; }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, error, success, setError, run };
}
