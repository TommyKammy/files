import type { FileLockSnapshot } from '../durable-objects/file-lock-hub';
import type { OidcEnv } from '../types/oidc';

export class FileLockedError extends Error {
  readonly status = 409;
  readonly code = 'FILE_LOCKED';

  constructor(public readonly lock: FileLockSnapshot) {
    super(`File is locked by ${lock.ownerName} (${lock.mode})`);
    this.name = 'FileLockedError';
  }
}

export async function getFileLockState(
  env: Pick<OidcEnv, 'FILE_LOCK_HUB'>,
  fileId: string
): Promise<FileLockSnapshot | null> {
  if (!env.FILE_LOCK_HUB || !fileId) return null;
  try {
    const stub = env.FILE_LOCK_HUB.get(env.FILE_LOCK_HUB.idFromName(fileId));
    const result = await stub.getLock({ fileId });
    return result.lock;
  } catch (err) {
    console.warn('[file-lock] Failed to read lock state:', err);
    return null;
  }
}

/**
 * Shared guard for destructive file mutations. WOPI and Files Drive both use the
 * same FileLockHub instance, so a lock held by either path blocks D1 mutations.
 */
export async function assertFileNotLocked(
  env: Pick<OidcEnv, 'FILE_LOCK_HUB'>,
  fileId: string
): Promise<void> {
  const lock = await getFileLockState(env, fileId);
  if (lock) {
    throw new FileLockedError(lock);
  }
}
