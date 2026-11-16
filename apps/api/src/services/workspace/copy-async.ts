import type { AuthUser } from '../../types/api';
import type { CopySubtreeQueueMessage } from '../../types/classification';
import type {
  CopyFrontierEntry,
  CopyJobState,
  CopyWorkspaceResult,
  DestinationContext,
  CopyableFileRow,
} from './shared';
import type { FolderRow } from '../folder-closure-service';

export async function enqueueCopySubtreeJob({
  db,
  queue,
  user,
  dest,
  rootFolders,
  rootFiles,
  rootFolderTargetNames,
  rootFileTargetNames,
  totalNodes,
  nowIso,
}: {
  db: D1Database;
  queue: Queue;
  user: AuthUser;
  dest: DestinationContext;
  rootFolders: Array<{ row: FolderRow }>;
  rootFiles: Array<{ row: CopyableFileRow }>;
  rootFolderTargetNames: Map<string, string>;
  rootFileTargetNames: Map<string, string>;
  totalNodes: number;
  nowIso: string;
}): Promise<CopyWorkspaceResult> {
  const jobId = crypto.randomUUID();
  const initialFrontier: CopyFrontierEntry[] = [
    ...rootFolders.map((entry) => ({
      kind: 'folder' as const,
      srcId: entry.row.id,
      destParentId: dest.parentId,
      targetName: rootFolderTargetNames.get(entry.row.id)!,
      depth: dest.parentId === null ? 0 : dest.depth + 1,
    })),
    ...rootFiles.map((entry) => ({
      kind: 'file' as const,
      srcId: entry.row.id,
      destParentId: dest.parentId,
      targetName: rootFileTargetNames.get(entry.row.id)!,
    })),
  ];

  const state: CopyJobState = {
    frontier: initialFrontier,
    destFloor: dest.floorClassification,
    createdFolderIds: [],
    scopeFolderIds: [dest.parentId],
  };

  await db
    .prepare(
      `INSERT INTO workspace_jobs (
         id, tenant_id, job_type, status, total_items, processed_items,
         target_folder_id, created_by, pending_json, created_at, updated_at
       ) VALUES (?, ?, 'copy_subtree', 'queued', ?, 0, ?, ?, ?, ?, ?)`
    )
    .bind(
      jobId,
      user.tenantId,
      totalNodes,
      dest.parentId,
      user.id,
      JSON.stringify(state),
      nowIso,
      nowIso
    )
    .run();

  await queue.send({
    type: 'copy_subtree',
    jobId,
    tenantId: user.tenantId,
    actorId: user.id,
    actorEmail: user.email,
    actorIp: user.ipAddress,
  } satisfies CopySubtreeQueueMessage);

  return {
    ok: true,
    queued: true,
    jobId,
    totalItems: totalNodes,
    copiedFolders: [],
    copiedFiles: [],
    syncSeq: null,
    scopeFolderIds: [dest.parentId],
  };
}
