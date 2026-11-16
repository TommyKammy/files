import type { AuthUser, ClassificationLabel } from '../../types/api';
import { pickStricterClassification } from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import { buildSyncChangeStmt } from '../sync-changes';
import {
  FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  hasDuplicateFolderName,
  validateFolderName,
} from './shared';

export async function createFolderWithClosures(
  db: D1Database,
  user: AuthUser,
  input: {
    name: unknown;
    parentId?: string | null;
    classification?: ClassificationLabel;
    isPinned?: boolean;
  }
): Promise<FolderRow> {
  const name = validateFolderName(input.name);
  const parentId = input.parentId ?? null;

  let parentFolder: FolderRow | null = null;
  if (parentId !== null) {
    const access = await resolveTargetAccess(db, user, 'folder', parentId);
    if (!access || access.deletedAt !== null) {
      throw new FolderServiceError(404, 'PARENT_NOT_FOUND', 'Parent folder not found');
    }
    if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
      throw new FolderServiceError(403, 'FORBIDDEN', 'Editor permission required on parent folder');
    }
    parentFolder = await db
      .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(user.tenantId, parentId)
      .first<FolderRow>();
    if (!parentFolder) {
      throw new FolderServiceError(404, 'PARENT_NOT_FOUND', 'Parent folder not found');
    }
  }

  const depth = parentFolder ? parentFolder.depth + 1 : 0;
  if (depth > MAX_FOLDER_DEPTH) {
    throw new FolderServiceError(
      400,
      'MAX_DEPTH_EXCEEDED',
      `Folder depth cannot exceed ${MAX_FOLDER_DEPTH} levels`
    );
  }

  if (await hasDuplicateFolderName(db, user.tenantId, parentId, name)) {
    throw new FolderServiceError(
      409,
      'NAME_CONFLICT',
      `A folder named "${name}" already exists in this location`
    );
  }

  const baseClassification = parentFolder?.classification ?? 'unset';
  const classification = input.classification
    ? pickStricterClassification(baseClassification, input.classification)
    : baseClassification;

  const folderId = crypto.randomUUID();
  const isPinned = input.isPinned ? 1 : 0;
  const nowIso = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification,
           is_pinned, created_by, deleted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)`
      )
      .bind(
        folderId,
        user.tenantId,
        parentId,
        name,
        depth,
        classification,
        isPinned,
        user.id,
        nowIso,
        nowIso
      ),
    db
      .prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, 0)`
      )
      .bind(user.tenantId, folderId, folderId),
  ];

  if (parentFolder) {
    const ancestors = await db
      .prepare(
        `SELECT ancestor_id, depth
           FROM folder_closures
          WHERE tenant_id = ? AND descendant_id = ?`
      )
      .bind(user.tenantId, parentFolder.id)
      .all<{ ancestor_id: string; depth: number }>();

    for (const anc of ancestors.results) {
      statements.push(
        db
          .prepare(
            `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
             VALUES (?, ?, ?, ?)`
          )
          .bind(user.tenantId, anc.ancestor_id, folderId, anc.depth + 1)
      );
    }
  } else {
    // Root folders automatically assign direct owner role to creator
    statements.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
           ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)`
        )
        .bind(crypto.randomUUID(), user.tenantId, folderId, user.id, user.id, nowIso)
    );
  }

  const createdFolder: FolderRow = {
    id: folderId,
    tenant_id: user.tenantId,
    parent_id: parentId,
    name,
    depth,
    version: 1,
    classification,
    is_pinned: isPinned,
    created_by: user.id,
    deleted_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.create',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: classification,
      metadata: { parentId, name, depth },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: parentId,
      action: 'folder.create',
      payload: {
        folder: createdFolder,
      },
      nowIso,
    })
  );

  await db.batch(statements);

  return createdFolder;
}

