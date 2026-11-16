import { DurableObject } from 'cloudflare:workers';
import type { OidcEnv } from '../types/oidc';
import { notifyTenantSyncHub } from '../services/sync-notifier';

export type FileLockMode = 'wopi_collab' | 'desktop_exclusive';

export interface FileLockSnapshot {
  fileId: string;
  tenantId: string;
  mode: FileLockMode;
  lockId: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string | null;
  sessionId: string | null;
  acquiredAt: number;
  expiresAt: number;
  updatedAt: number;
}

export interface FileLockAcquireInput {
  fileId: string;
  tenantId: string;
  mode: FileLockMode;
  lockId: string;
  ownerId: string;
  ownerName: string;
  ownerEmail?: string | null;
  sessionId?: string | null;
  ttlSeconds?: number;
}

export interface FileLockTokenInput {
  fileId: string;
  lockId: string;
}

export interface FileLockRefreshInput extends FileLockTokenInput {
  ttlSeconds?: number;
}

export interface FileLockUnlockAndRelockInput extends FileLockTokenInput {
  newLockId: string;
  ttlSeconds?: number;
}

export type FileLockSuccess = { ok: true; lock: FileLockSnapshot };
export type FileLockConflict = {
  ok: false;
  conflict: true;
  lock: FileLockSnapshot | null;
};
export type FileLockResult = FileLockSuccess | FileLockConflict;
export type FileLockReleaseResult =
  | { ok: true; released: boolean }
  | FileLockConflict;

const DEFAULT_LOCK_TTL_SECONDS = 30 * 60;
const MAX_LOCK_TTL_SECONDS = 24 * 60 * 60;

function normalizeTtlSeconds(ttlSeconds?: number): number {
  const parsed =
    typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)
      ? Math.floor(ttlSeconds)
      : DEFAULT_LOCK_TTL_SECONDS;
  return Math.max(1, Math.min(parsed, MAX_LOCK_TTL_SECONDS));
}

type FileLockRow = {
  file_id: string;
  tenant_id: string;
  mode: string;
  lock_id: string;
  owner_id: string;
  owner_name: string;
  owner_email: string | null;
  session_id: string | null;
  acquired_at: number;
  expires_at: number;
  updated_at: number;
};

function rowToSnapshot(row: FileLockRow): FileLockSnapshot {
  return {
    fileId: row.file_id,
    tenantId: row.tenant_id,
    mode: row.mode === 'desktop_exclusive' ? 'desktop_exclusive' : 'wopi_collab',
    lockId: row.lock_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    sessionId: row.session_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Per-file SQLite-backed Durable Object holding the single source of truth for
 * WOPI collaborative locks and future Files Drive desktop-exclusive locks.
 *
 * Stub identity: `FILE_LOCK_HUB.idFromName(fileId)`.
 */
export class FileLockHub extends DurableObject<OidcEnv> {
  constructor(ctx: DurableObjectState, env: OidcEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS file_lock (
          file_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          lock_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          owner_name TEXT NOT NULL,
          owner_email TEXT,
          session_id TEXT,
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    });
  }

  private readRawLock(): FileLockSnapshot | null {
    const rows = this.ctx.storage.sql
      .exec<FileLockRow>('SELECT * FROM file_lock LIMIT 1')
      .toArray();
    const row = rows[0];
    return row ? rowToSnapshot(row) : null;
  }

  private writeLock(lock: FileLockSnapshot): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO file_lock (
         file_id, tenant_id, mode, lock_id, owner_id, owner_name, owner_email,
         session_id, acquired_at, expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         mode = excluded.mode,
         lock_id = excluded.lock_id,
         owner_id = excluded.owner_id,
         owner_name = excluded.owner_name,
         owner_email = excluded.owner_email,
         session_id = excluded.session_id,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      lock.fileId,
      lock.tenantId,
      lock.mode,
      lock.lockId,
      lock.ownerId,
      lock.ownerName,
      lock.ownerEmail,
      lock.sessionId,
      lock.acquiredAt,
      lock.expiresAt,
      lock.updatedAt
    );
    this.ctx.storage.setAlarm(lock.expiresAt);
  }

  private deleteLock(): void {
    this.ctx.storage.sql.exec('DELETE FROM file_lock');
    this.ctx.storage.deleteAlarm();
  }

  private async notifyChange(
    lock: FileLockSnapshot | null,
    reason: 'acquired' | 'refreshed' | 'released' | 'expired' | 'relocked',
    previous: FileLockSnapshot | null = null
  ): Promise<void> {
    const tenantId = lock?.tenantId ?? previous?.tenantId;
    if (!tenantId) return;
    await notifyTenantSyncHub(this.env, {
      tenantId,
      eventKind: 'file.lock_changed',
      scopeFolderIds: [],
      metadata: {
        fileId: lock?.fileId ?? previous?.fileId ?? null,
        reason,
        lock,
      },
    });
  }

  private async releaseExpired(now: number): Promise<FileLockSnapshot | null> {
    const current = this.readRawLock();
    if (!current || current.expiresAt > now) return current;
    this.deleteLock();
    await this.notifyChange(null, 'expired', current);
    return null;
  }

  async getLock(input?: { fileId?: string }): Promise<{
    fileId: string;
    lock: FileLockSnapshot | null;
  }> {
    const current = await this.releaseExpired(Date.now());
    return {
      fileId: current?.fileId ?? input?.fileId ?? '',
      lock: current,
    };
  }

  async lockFile(input: FileLockAcquireInput): Promise<FileLockResult> {
    const now = Date.now();
    const current = await this.releaseExpired(now);

    if (
      current &&
      (current.lockId !== input.lockId ||
        current.mode !== input.mode ||
        current.tenantId !== input.tenantId)
    ) {
      return { ok: false, conflict: true, lock: current };
    }

    if (current && current.lockId === input.lockId) {
      const refreshed: FileLockSnapshot = {
        ...current,
        expiresAt: now + normalizeTtlSeconds(input.ttlSeconds) * 1000,
        updatedAt: now,
      };
      this.writeLock(refreshed);
      await this.notifyChange(refreshed, 'refreshed', current);
      return { ok: true, lock: refreshed };
    }

    const lock: FileLockSnapshot = {
      fileId: input.fileId,
      tenantId: input.tenantId,
      mode: input.mode,
      lockId: input.lockId,
      ownerId: input.ownerId,
      ownerName: input.ownerName,
      ownerEmail: input.ownerEmail ?? null,
      sessionId: input.sessionId ?? null,
      acquiredAt: now,
      expiresAt: now + normalizeTtlSeconds(input.ttlSeconds) * 1000,
      updatedAt: now,
    };
    this.writeLock(lock);
    await this.notifyChange(lock, 'acquired');
    return { ok: true, lock };
  }

  async refreshLock(input: FileLockRefreshInput): Promise<FileLockResult> {
    const now = Date.now();
    const current = await this.releaseExpired(now);
    if (!current || current.lockId !== input.lockId) {
      return { ok: false, conflict: true, lock: current };
    }
    const refreshed: FileLockSnapshot = {
      ...current,
      expiresAt: now + normalizeTtlSeconds(input.ttlSeconds) * 1000,
      updatedAt: now,
    };
    this.writeLock(refreshed);
    await this.notifyChange(refreshed, 'refreshed', current);
    return { ok: true, lock: refreshed };
  }

  async unlockFile(input: FileLockTokenInput): Promise<FileLockReleaseResult> {
    const now = Date.now();
    const current = await this.releaseExpired(now);
    if (!current) {
      return { ok: true, released: false };
    }
    if (current.lockId !== input.lockId) {
      return { ok: false, conflict: true, lock: current };
    }
    this.deleteLock();
    await this.notifyChange(null, 'released', current);
    return { ok: true, released: true };
  }

  async unlockAndRelock(
    input: FileLockUnlockAndRelockInput
  ): Promise<FileLockResult> {
    const now = Date.now();
    const current = await this.releaseExpired(now);
    if (!current || current.lockId !== input.lockId) {
      return { ok: false, conflict: true, lock: current };
    }
    const next: FileLockSnapshot = {
      ...current,
      lockId: input.newLockId,
      expiresAt: now + normalizeTtlSeconds(input.ttlSeconds) * 1000,
      updatedAt: now,
    };
    this.writeLock(next);
    await this.notifyChange(next, 'relocked', current);
    return { ok: true, lock: next };
  }

  /** Called by tests and maintenance to release a timed-out lock deterministically. */
  async purgeExpired(): Promise<{
    released: boolean;
    lock: FileLockSnapshot | null;
  }> {
    const current = this.readRawLock();
    const remaining = await this.releaseExpired(Date.now());
    return {
      released: Boolean(current) && remaining === null,
      lock: remaining,
    };
  }

  async getStats(): Promise<{
    locked: boolean;
    mode: FileLockMode | null;
    expiresAt: number | null;
  }> {
    const current = await this.releaseExpired(Date.now());
    return {
      locked: Boolean(current),
      mode: current?.mode ?? null,
      expiresAt: current?.expiresAt ?? null,
    };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const current = this.readRawLock();
    if (!current) return;
    if (current.expiresAt <= now) {
      this.deleteLock();
      await this.notifyChange(null, 'expired', current);
      return;
    }
    this.ctx.storage.setAlarm(current.expiresAt);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/state') {
      return Response.json(await this.getLock());
    }
    if (url.pathname === '/stats') {
      return Response.json(await this.getStats());
    }
    return new Response('Not Found', { status: 404 });
  }
}
