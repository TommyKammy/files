'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  acceptTosVersion,
  ApiClientError,
  fetchTosStatus,
} from '@/lib/files-api';
import type { TenantBranding, TosStatus } from '@/types/files';

function readErrorVersion(err: unknown): number | null {
  if (!(err instanceof ApiClientError)) return null;
  const version = err.details?.version;
  return typeof version === 'number' && Number.isInteger(version) && version > 0
    ? version
    : null;
}

/**
 * Shared ToS gate for workspace surfaces.
 *
 * The gate has two triggers:
 * 1. `GET /api/auth/tos` (and the bootstrap `tosStatus`) shows the current
 *    version still needs acceptance.
 * 2. A workspace API returns `403 TOS_ACCEPTANCE_REQUIRED` because the policy
 *    was enabled after the page loaded.
 *
 * Acceptance always reloads the page after the idempotent POST succeeds, which
 * immediately releases every workspace/share API blocked by the middleware.
 */
export function useTosAcceptance({
  bootstrapStatus = null,
  apiErrorCode = null,
}: {
  bootstrapStatus?: TosStatus | null;
  apiErrorCode?: string | null;
} = {}) {
  const [status, setStatus] = useState<TosStatus | null>(null);
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiBlocked, setApiBlocked] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchTosStatus(signal);
      setStatus(data.tos);
      setBranding(data.branding ?? null);
      setError(null);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      // Authentication failures are handled by the surrounding shell.
      if (err instanceof ApiClientError && err.status === 401) return;
      setError(
        err instanceof Error
          ? err.message
          : '利用規約の読み込みに失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (apiErrorCode === 'TOS_ACCEPTANCE_REQUIRED') {
      setApiBlocked(true);
      void refresh();
    }
  }, [apiErrorCode, refresh]);

  const effectiveStatus = status ?? bootstrapStatus ?? null;
  const blocked =
    apiBlocked ||
    Boolean(status?.requiresAcceptance) ||
    Boolean(bootstrapStatus?.requiresAcceptance);
  const version = effectiveStatus?.version ?? 1;

  const accept = useCallback(async () => {
    if (accepting) return;
    setAccepting(true);
    setError(null);
    try {
      await acceptTosVersion(version);
      // Full reload re-runs bootstrap and releases the shell without keeping
      // any pre-acceptance cached state in memory.
      if (typeof window !== 'undefined') {
        window.location.reload();
        return;
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        await refresh();
        setError(
          '利用規約が更新されました。最新の内容を確認して、もう一度同意してください。'
        );
      } else {
        setError(
          err instanceof Error
            ? err.message
            : '利用規約への同意に失敗しました'
        );
      }
    } finally {
      setAccepting(false);
    }
  }, [accepting, refresh, version]);

  return useMemo(
    () => ({
      status: effectiveStatus,
      branding,
      loading,
      accepting,
      error,
      blocked,
      version,
      accept,
      refresh,
    }),
    [
      effectiveStatus,
      branding,
      loading,
      accepting,
      error,
      blocked,
      version,
      accept,
      refresh,
    ]
  );
}
