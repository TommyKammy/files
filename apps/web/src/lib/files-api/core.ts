

export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MULTIPART_CONCURRENCY = 4;
export const PART_URL_BATCH_SIZE = 100;

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function buildLoginUrl(returnTo?: string): string {
  const target =
    returnTo ??
    (typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}`
      : '/workspace');
  return `/auth/login?returnTo=${encodeURIComponent(target)}`;
}

export type AuthRevokedHook = () => Promise<void> | void;
export const authRevokedHooks = new Set<AuthRevokedHook>();

/**
 * Register a client cache/store purge hook invoked immediately on HTTP 401 or logout
 * so confidential IndexedDB metadata never lingers across session revocation.
 */
export function registerAuthPurgeHook(hook: AuthRevokedHook): () => void {
  authRevokedHooks.add(hook);
  return () => {
    authRevokedHooks.delete(hook);
  };
}

export async function runAuthPurgeHooks(): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  for (const hook of authRevokedHooks) {
    try {
      const res = hook();
      if (res && typeof (res as Promise<void>).then === 'function') {
        tasks.push(res);
      }
    } catch {
      // ignore listener errors during teardown
    }
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  });

  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      void runAuthPurgeHooks();
    }
    const message =
      typeof parsed?.error === 'string'
        ? parsed.error
        : `Request failed with HTTP ${res.status}`;
    const code = typeof parsed?.code === 'string' ? parsed.code : undefined;
    throw new ApiClientError(res.status, message, code, parsed ?? undefined);
  }

  return (parsed ?? {}) as T;
}


