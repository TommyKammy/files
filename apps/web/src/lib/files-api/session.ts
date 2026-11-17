import type {
  AuthUser,
  BootstrapResponse,
  DevAuthAccountsResponse,
  SyncDeltaResponse,
  SyncWsTicketResponse,
  TosStatusResponse,
  UserRole,
} from '@/types/files';
import {
  apiFetch,
  runAuthPurgeHooks,
} from './core';

export function fetchCurrentUser(): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>('/api/auth/me');
}

export function fetchSyncBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  return apiFetch<BootstrapResponse>('/api/sync/bootstrap', { signal });
}

/** GET /api/auth/tos — tenant policy + caller acceptance state. */
export function fetchTosStatus(signal?: AbortSignal): Promise<TosStatusResponse> {
  return apiFetch<TosStatusResponse>('/api/auth/tos', { signal });
}

/** POST /api/auth/tos/accept — idempotently accept the current version. */
export function acceptTosVersion(version: number): Promise<
  TosStatusResponse & { ok: boolean }
> {
  return apiFetch('/api/auth/tos/accept', {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}

export function fetchSyncDelta(
  sinceSeq: number,
  limit = 200,
  signal?: AbortSignal
): Promise<SyncDeltaResponse> {
  const params = new URLSearchParams({
    sinceSeq: String(Math.max(0, Math.floor(sinceSeq))),
    limit: String(Math.min(Math.max(1, Math.floor(limit)), 200)),
  });
  return apiFetch<SyncDeltaResponse>(`/api/sync/delta?${params.toString()}`, { signal });
}

export function requestSyncWsTicket(
  signal?: AbortSignal
): Promise<SyncWsTicketResponse> {
  return apiFetch<SyncWsTicketResponse>('/api/sync/ws-ticket', {
    method: 'POST',
    signal,
  });
}

function isLocalhostClient(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export async function fetchDevAuthAccounts(): Promise<DevAuthAccountsResponse> {
  if (!isLocalhostClient()) {
    return { enabled: false, accounts: [] };
  }
  try {
    const res = await fetch('/auth/dev-accounts', { credentials: 'include' });
    if (!res.ok) {
      return { enabled: false, accounts: [] };
    }
    const body = (await res.json()) as Partial<DevAuthAccountsResponse>;
    return {
      enabled: Boolean(body.enabled),
      tenantId: body.tenantId,
      accounts: Array.isArray(body.accounts) ? body.accounts : [],
    };
  } catch {
    return { enabled: false, accounts: [] };
  }
}

export async function loginWithDevAccount(payload: {
  userId?: string;
  role?: UserRole;
}): Promise<{ ok: boolean; user: Omit<AuthUser, 'ipAddress'> }> {
  return apiFetch('/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function logoutSession(): Promise<void> {
  await runAuthPurgeHooks();
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
}


