import type { AuthUser, ClassificationLabel } from '../../types/api';
import type { CopySubtreeQueueMessage } from '../../types/classification';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import { pickStricterClassification } from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import {
  buildClassificationPolicyStatements,
  resolveFolderClassificationFloor,
} from '../classification-updater';
import {
  type FileRow,
  FileUploadError,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../file-upload-common';
import {
  type FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  moveFolderSubtree,
  validateFolderName,
} from '../folder-closure-service';
import { buildSyncChangeStmt, getSyncWatermarks } from '../sync-changes';
import { notifyTenantSyncHub } from '../sync-notifier';
import type { OidcEnv } from '../../types/oidc';

import {
  ASYNC_COPY_CHUNK_NODES,
  CopyJobState,
  CopyableFileRow,
  appendStatsAndFolderCopyStatements,
  appendStatsDeltasStatements,
  buildCoWFileCopyStatements,
  resolveLatestSyncSeq,
} from './shared';

export async function processCopySubtreeJobChunk(
  msg: CopySubtreeQueueMessage,
  env: OidcEnv
): Promise<void> {
  const job = await env.DB.prepare(
    `SELECT id, tenant_id, status, total_items, processed_items, target_folder_id, pending_json
       FROM workspace_jobs
      WHERE tenant_id = ? AND id = ?`
  )
    .bind(msg.tenantId, msg.jobId)
    .first<{
      id: string;
      tenant_id: string;
      status: string;
      total_items: number;
      processed_items: number;
      target_folder_id: string | null;
      pending_json: string | null;
    }>();

  if (!job || job.status === 'completed' || job.status === 'failed' || !job.pending_json) {
    return;
  }

  const state = JSON.parse(job.pending_json) as CopyJobState;
  const createdSet = new Set(state.createdFolderIds);
  const scopeSet = new Set<string | null>(state.scopeFolderIds);
  const nowIso = new Date().toISOString();
  const actor = { id: msg.actorId, email: msg.actorEmail, ipAddress: msg.actorIp };

  const stmts: D1PreparedStatement[] = [];
  const createdFolders: FolderRow[] = [];
  const createdFiles: FileRow[] = [];
  const statsDeltas = new Map<ClassificationLabel, { count: number; bytes: number }>();

  let processedInTurn = 0;
  const frontier = [...state.frontier];

  try {
    while (frontier.length > 0 && processedInTurn < ASYNC_COPY_CHUNK_NODES) {
      const next = frontier.shift()!;
      processedInTurn += 1;

      if (next.kind === 'folder') {
        const orig = await env.DB.prepare(
          'SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
        )
          .bind(msg.tenantId, next.srcId)
          .first<FolderRow>();
        if (!orig) continue;

        const newFolderId = crypto.randomUUID();
        createdSet.add(newFolderId);
        scopeSet.add(next.destParentId);
        scopeSet.add(newFolderId);

        appendStatsAndFolderCopyStatements(env.DB, {
          tenantId: msg.tenantId,
          actor,
          orig,
          newFolderId,
          destParentId: next.destParentId,
          targetName: next.targetName,
          depth: next.depth ?? 0,
          destFloor: state.destFloor,
          nowIso,
          stmts,
          createdFolders,
        });

        const [childFolders, childFiles] = await Promise.all([
          env.DB.prepare(
            `SELECT id, name FROM folders
              WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL
              ORDER BY name ASC`
          )
            .bind(msg.tenantId, orig.id)
            .all<{ id: string; name: string }>(),
          env.DB.prepare(
            `SELECT id, name FROM files
              WHERE tenant_id = ? AND folder_id = ? AND deleted_at IS NULL AND upload_state = 'active'
              ORDER BY name ASC`
          )
            .bind(msg.tenantId, orig.id)
            .all<{ id: string; name: string }>(),
        ]);

        for (const cf of childFolders.results) {
          if (createdSet.has(cf.id)) continue; // Avoid re-traversing newly created self-copy branch
          frontier.push({
            kind: 'folder',
            srcId: cf.id,
            destParentId: newFolderId,
            targetName: cf.name,
            depth: (next.depth ?? 0) + 1,
          });
        }
        for (const fl of childFiles.results) {
          frontier.push({
            kind: 'file',
            srcId: fl.id,
            destParentId: newFolderId,
            targetName: fl.name,
          });
        }
      } else {
        const orig = await env.DB.prepare(
          `SELECT fl.*, fv.r2_object_key
             FROM files fl
             JOIN file_versions fv ON fv.id = fl.current_version_id
            WHERE fl.tenant_id = ? AND fl.id = ? AND fl.deleted_at IS NULL AND fl.upload_state = 'active'`
        )
          .bind(msg.tenantId, next.srcId)
          .first<CopyableFileRow>();
        if (!orig) continue;

        scopeSet.add(next.destParentId);
        buildCoWFileCopyStatements(env.DB, {
          tenantId: msg.tenantId,
          actor,
          orig,
          destFolderId: next.destParentId,
          targetName: next.targetName,
          destFloor: state.destFloor,
          nowIso,
          stmts,
          statsDeltas,
          createdFiles,
        });
      }
    }

    appendStatsDeltasStatements(env.DB, msg.tenantId, nowIso, statsDeltas, stmts);

    const hasMore = frontier.length > 0;
    const nextProcessed = job.processed_items + processedInTurn;
    const nextState: CopyJobState = {
      frontier,
      destFloor: state.destFloor,
      createdFolderIds: [...createdSet],
      scopeFolderIds: [...scopeSet],
    };

    stmts.push(
      env.DB.prepare(
        `UPDATE workspace_jobs
            SET status = ?, processed_items = ?, pending_json = ?,
                result_json = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(
        hasMore ? 'running' : 'completed',
        nextProcessed,
        hasMore ? JSON.stringify(nextState) : null,
        hasMore
          ? null
          : JSON.stringify({
              completedAt: nowIso,
              processedItems: nextProcessed,
              scopeFolderIds: [...scopeSet],
            }),
        nowIso,
        msg.tenantId,
        msg.jobId
      )
    );

    await executeBatchChunks(env.DB, stmts, 30);

    if (hasMore) {
      await env.JOBS_QUEUE.send(msg);
    } else {
      const syncSeq = await resolveLatestSyncSeq(env.DB, msg.tenantId);
      await notifyTenantSyncHub(env, {
        tenantId: msg.tenantId,
        seq: syncSeq,
        eventKind: 'workspace.copy',
        scopeFolderIds: [...scopeSet],
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Async subtree copy failed';
    await env.DB.prepare(
      `UPDATE workspace_jobs
          SET status = 'failed', error_message = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(message.slice(0, 500), new Date().toISOString(), msg.tenantId, msg.jobId)
      .run();
    throw err;
  }
}

export async function getWorkspaceJobStatus(
  db: D1Database,
  tenantId: string,
  jobId: string
): Promise<{
  id: string;
  jobType: string;
  status: string;
  totalItems: number;
  processedItems: number;
  targetFolderId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, job_type, status, total_items, processed_items, target_folder_id,
              error_message, created_at, updated_at
         FROM workspace_jobs
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, jobId)
    .first<{
      id: string;
      job_type: string;
      status: string;
      total_items: number;
      processed_items: number;
      target_folder_id: string | null;
      error_message: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    totalItems: row.total_items,
    processedItems: row.processed_items,
    targetFolderId: row.target_folder_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
