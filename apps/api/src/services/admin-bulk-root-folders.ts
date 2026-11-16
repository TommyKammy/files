import type { AuthUser } from '../types/api';
import type { OidcEnv } from '../types/oidc';
import { buildAuditLogStmt } from './audit';
import {
  AdminRootFolderError,
  archiveAdminRootFolder,
  assertAdminRootFolderArchivable,
  assertAdminRootFolderRestorable,
  loadAdminRootFolderCandidates,
  restoreAdminRootFolder,
} from './admin-root-folders';
import {
  buildAdminBulkSummary,
  failedResult,
  normalizeBulkFolderIds,
  successResult,
  type AdminBulkItemResult,
  type AdminBulkResponse,
} from './admin-bulk';
import {
  beginAdminBulkOperation,
  resolveIdempotencyKey,
} from './admin-bulk-idempotency';
import { FileLockedError } from './file-lock';
import { FolderServiceError } from './folder-closure-service';

export interface BulkRootFolderInput {
  folderIds: unknown;
  dryRun?: unknown;
  idempotencyKey?: unknown;
  headerIdempotencyKey?: string | null;
}

function mapArchiveError(
  folderId: string,
  folderName: string,
  err: unknown
): AdminBulkItemResult {
  if (err instanceof FileLockedError) {
    return failedResult(
      folderId,
      folderName,
      err.code,
      'A file in the root subtree is locked for desktop editing'
    );
  }
  if (err instanceof AdminRootFolderError) {
    return failedResult(folderId, folderName, err.code, err.message);
  }
  if (err instanceof FolderServiceError) {
    return failedResult(folderId, folderName, err.code, err.message);
  }
  return failedResult(
    folderId,
    folderName,
    'INTERNAL_ERROR',
    err instanceof Error ? err.message : 'Bulk operation failed'
  );
}

async function runBulkLifecycleOperation(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  input: BulkRootFolderInput,
  mode: 'archive' | 'restore'
): Promise<AdminBulkResponse> {
  const db = env.DB;
  const folderIds = normalizeBulkFolderIds(input.folderIds);
  const dryRun = input.dryRun === true;
  const operation =
    mode === 'archive'
      ? 'admin.root_folder.bulk_archive'
      : 'admin.root_folder.bulk_restore';
  const payload = { folderIds: [...folderIds].sort() };

  const candidates = await loadAdminRootFolderCandidates(
    db,
    user.tenantId,
    folderIds
  );

  async function previewOne(folderId: string): Promise<AdminBulkItemResult> {
    const folderName = candidates.get(folderId)?.name ?? '';
    try {
      if (mode === 'archive') {
        const folder = await assertAdminRootFolderArchivable(
          env,
          user.tenantId,
          folderId
        );
        return successResult(
          folder.id,
          folder.name,
          'アーカイブ可能（配下のフォルダ・ファイルを含む）'
        );
      }
      const folder = await assertAdminRootFolderRestorable(
        db,
        user.tenantId,
        folderId
      );
      return successResult(
        folder.id,
        folder.name,
        '復元可能（アーカイブ済み配下を含む）'
      );
    } catch (err) {
      return mapArchiveError(folderId, folderName, err);
    }
  }

  if (dryRun) {
    const results: AdminBulkItemResult[] = [];
    for (const folderId of folderIds) {
      results.push(await previewOne(folderId));
    }
    return {
      operation,
      dryRun: true,
      replayed: false,
      results,
      summary: buildAdminBulkSummary(results),
      syncSeq: null,
    };
  }

  const idempotencyKey = resolveIdempotencyKey(
    input.idempotencyKey,
    input.headerIdempotencyKey
  );
  const session = await beginAdminBulkOperation<Omit<AdminBulkResponse, 'replayed'>>({
    db,
    tenantId: user.tenantId,
    operation,
    idempotencyKey,
    payload,
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const results: AdminBulkItemResult[] = [];
    const details: Array<Record<string, unknown>> = [];
    let latestSyncSeq: number | null = null;

    for (const folderId of folderIds) {
      const folderName = candidates.get(folderId)?.name ?? '';
      try {
        if (mode === 'archive') {
          const result = await archiveAdminRootFolder(env, user, folderId);
          if (result.syncSeq !== null) latestSyncSeq = result.syncSeq;
          results.push(
            successResult(folderId, folderName, `アーカイブ日時: ${result.deletedAt}`)
          );
          details.push({
            folderId,
            folderName,
            status: 'succeeded',
            deletedAt: result.deletedAt,
          });
        } else {
          const result = await restoreAdminRootFolder(db, user, folderId);
          if (result.syncSeq !== null) latestSyncSeq = result.syncSeq;
          results.push(successResult(folderId, result.root.name, '復元しました'));
          details.push({
            folderId,
            folderName: result.root.name,
            status: 'succeeded',
            deletedAt: null,
          });
        }
      } catch (err) {
        const mapped = mapArchiveError(folderId, folderName, err);
        results.push(mapped);
        details.push({
          folderId,
          folderName,
          status: mapped.status,
          code: mapped.code,
          message: mapped.message,
        });
      }
    }

    const response: Omit<AdminBulkResponse, 'replayed'> = {
      operation,
      dryRun: false,
      results,
      summary: buildAdminBulkSummary(results),
      syncSeq: latestSyncSeq,
    };

    const audit = buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: operation,
      targetType: 'folder',
      targetId: 'bulk',
      metadata: {
        folderIds,
        summary: response.summary,
        details,
      },
    });
    await audit.run();

    await session.complete(response);
    return { ...response, replayed: false };
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export function bulkArchiveAdminRootFolders(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  input: BulkRootFolderInput
): Promise<AdminBulkResponse> {
  return runBulkLifecycleOperation(env, user, input, 'archive');
}

export function bulkRestoreAdminRootFolders(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  input: BulkRootFolderInput
): Promise<AdminBulkResponse> {
  return runBulkLifecycleOperation(env, user, input, 'restore');
}
