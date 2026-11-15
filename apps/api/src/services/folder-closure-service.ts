import type { AuthUser, ClassificationLabel, ResourceRole } from '../types/api';
import {
  CLASSIFICATION_STRICTNESS,
  isClassificationStricter,
  pickStricterClassification,
} from '../utils/classification';
import { buildAuditLogStmt } from './audit';
import { hasAtLeastRole, resolveTargetAccess } from './authorization';
import { buildSyncChangeStmt } from './sync-changes';

export const MAX_FOLDER_DEPTH = 20;
const INLINE_CLASSIFICATION_PROPAGATION_LIMIT = 100;

export class FolderServiceError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string,
    public readonly latest?: FolderRow
  ) {
    super(message);
    this.name = 'FolderServiceError';
  }
}

export interface FolderRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  depth: number;
  version: number;
  classification: ClassificationLabel;
  is_pinned: number;
  created_by: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BreadcrumbItem {
  id: string;
  name: string;
  classification: ClassificationLabel;
  depth: number;
  version: number;
}

interface ClassificationStatsBucket {
  classification: ClassificationLabel;
  cnt: number;
  bytes: number;
}

export function validateFolderName(rawName: unknown): string {
  if (typeof rawName !== 'string') {
    throw new FolderServiceError(400, 'INVALID_NAME', 'Folder name must be a string');
  }
  const name = rawName.trim();
  if (!name || name.length > 255) {
    throw new FolderServiceError(400, 'INVALID_NAME', 'Folder name must be 1-255 characters');
  }
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new FolderServiceError(400, 'INVALID_NAME', 'Folder name contains invalid characters');
  }
  return name;
}

async function hasDuplicateFolderName(
  db: D1Database,
  tenantId: string,
  parentId: string | null,
  name: string,
  excludeFolderId?: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id
         FROM folders
        WHERE tenant_id = ?
          AND COALESCE(parent_id, '__ROOT__') = COALESCE(?, '__ROOT__')
          AND name = ?
          AND deleted_at IS NULL
          AND (? IS NULL OR id != ?)
        LIMIT 1`
    )
    .bind(tenantId, parentId, name, excludeFolderId ?? null, excludeFolderId ?? null)
    .first<{ id: string }>();
  return Boolean(row);
}

async function resolveUniqueRestoredName(
  db: D1Database,
  tenantId: string,
  parentId: string | null,
  baseName: string
): Promise<string> {
  const firstCandidate = `${baseName} (Restored)`;
  if (!(await hasDuplicateFolderName(db, tenantId, parentId, firstCandidate))) {
    return firstCandidate;
  }
  for (let suffix = 2; suffix <= 50; suffix++) {
    const candidate = `${baseName} (Restored ${suffix})`;
    if (!(await hasDuplicateFolderName(db, tenantId, parentId, candidate))) {
      return candidate;
    }
  }
  return `${baseName} (Restored ${crypto.randomUUID().slice(0, 6)})`;
}

export async function fetchFolderBreadcrumbsRows(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<BreadcrumbItem[]> {
  const rows = await db
    .prepare(
      `SELECT f.id, f.name, f.classification, f.depth, f.version
         FROM folder_closures fc
         JOIN folders f ON f.id = fc.ancestor_id
        WHERE fc.tenant_id = ?
          AND fc.descendant_id = ?
          AND f.deleted_at IS NULL
        ORDER BY fc.depth DESC`
    )
    .bind(tenantId, folderId)
    .all<BreadcrumbItem>();

  return rows.results;
}

export async function getFolderBreadcrumbs(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  folderId: string
): Promise<BreadcrumbItem[]> {
  const access = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!access || access.deletedAt !== null) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (!hasAtLeastRole(access.effectiveRole, 'previewer')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Forbidden');
  }

  return fetchFolderBreadcrumbsRows(db, user.tenantId, folderId);
}

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

export async function moveFolderSubtree(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  folderId: string,
  input: {
    targetParentId: string | null;
    expectedVersion?: number;
    targetName?: string;
  }
): Promise<{ folder: FolderRow; classificationJobQueued: boolean }> {
  const sourceAccess = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!sourceAccess || sourceAccess.deletedAt !== null) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (!hasAtLeastRole(sourceAccess.effectiveRole, 'editor')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Editor permission required to move folder');
  }

  const source = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!source) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }

  if (input.expectedVersion !== undefined && source.version !== input.expectedVersion) {
    throw new FolderServiceError(
      409,
      'VERSION_CONFLICT',
      `Folder version mismatch (expected ${input.expectedVersion}, actual ${source.version})`,
      source
    );
  }

  const targetParentId = input.targetParentId;
  if (targetParentId === folderId) {
    throw new FolderServiceError(400, 'CYCLE_DETECTED', 'Cannot move a folder into itself');
  }

  let targetParent: FolderRow | null = null;
  if (targetParentId !== null) {
    const destAccess = await resolveTargetAccess(db, user, 'folder', targetParentId);
    if (!destAccess || destAccess.deletedAt !== null) {
      throw new FolderServiceError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
    }
    if (!hasAtLeastRole(destAccess.effectiveRole, 'editor')) {
      throw new FolderServiceError(
        403,
        'FORBIDDEN',
        'Editor permission required on destination folder'
      );
    }

    targetParent = await db
      .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(user.tenantId, targetParentId)
      .first<FolderRow>();
    if (!targetParent) {
      throw new FolderServiceError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
    }

    // O(1) Cycle check via Closure Table primary key
    const cycleRow = await db
      .prepare(
        `SELECT 1 AS hit
           FROM folder_closures
          WHERE tenant_id = ? AND ancestor_id = ? AND descendant_id = ?
          LIMIT 1`
      )
      .bind(user.tenantId, folderId, targetParentId)
      .first<{ hit: number }>();
    if (cycleRow) {
      throw new FolderServiceError(
        400,
        'CYCLE_DETECTED',
        'Cannot move a folder into one of its descendants'
      );
    }
  } else if (source.parent_id !== null && !hasAtLeastRole(sourceAccess.effectiveRole, 'owner')) {
    throw new FolderServiceError(
      403,
      'FORBIDDEN',
      'Owner permission required to promote a folder to workspace root'
    );
  }

  // Max depth <= 20 check
  const maxSubDepthRow = await db
    .prepare(
      `SELECT COALESCE(MAX(depth), 0) AS max_sub_depth
         FROM folder_closures
        WHERE tenant_id = ? AND ancestor_id = ?`
    )
    .bind(user.tenantId, folderId)
    .first<{ max_sub_depth: number }>();
  const maxSubDepth = maxSubDepthRow?.max_sub_depth ?? 0;
  const newRootDepth = targetParent ? targetParent.depth + 1 : 0;

  if (newRootDepth + maxSubDepth > MAX_FOLDER_DEPTH) {
    throw new FolderServiceError(
      400,
      'MAX_DEPTH_EXCEEDED',
      `Move would exceed maximum depth of ${MAX_FOLDER_DEPTH}`
    );
  }

  const resolvedName =
    input.targetName !== undefined ? validateFolderName(input.targetName) : source.name;

  if (await hasDuplicateFolderName(db, user.tenantId, targetParentId, resolvedName, source.id)) {
    throw new FolderServiceError(
      409,
      'NAME_CONFLICT',
      `A folder named "${resolvedName}" already exists at the destination`
    );
  }

  // No-op move check when parent unchanged
  if (source.parent_id === targetParentId) {
    return { folder: source, classificationJobQueued: false };
  }

  const nowIso = new Date().toISOString();
  const depthDelta = newRootDepth - source.depth;
  const statements: D1PreparedStatement[] = [];

  // 1. Delete closure links between ancestors strictly outside subtree and nodes inside subtree
  if (source.parent_id !== null) {
    statements.push(
      db
        .prepare(
          `DELETE FROM folder_closures
            WHERE tenant_id = ?
              AND descendant_id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )
              AND ancestor_id IN (
                SELECT ancestor_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND descendant_id = ? AND ancestor_id != ?
              )`
        )
        .bind(user.tenantId, user.tenantId, folderId, user.tenantId, folderId, folderId)
    );
  }

  // 2. Connect destination parent's ancestors to every node in moved subtree
  if (targetParent) {
    statements.push(
      db
        .prepare(
          `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
           SELECT ?, anc.ancestor_id, sub.descendant_id, anc.depth + 1 + sub.depth
             FROM folder_closures anc
             CROSS JOIN folder_closures sub
            WHERE anc.tenant_id = ? AND anc.descendant_id = ?
              AND sub.tenant_id = ? AND sub.ancestor_id = ?`
        )
        .bind(user.tenantId, user.tenantId, targetParent.id, user.tenantId, folderId)
    );
  }

  // 3. Determine whether destination has stricter classification needing subtree elevation
  const destClassification = targetParent?.classification ?? 'unset';
  let nextSourceClassification = source.classification;
  let classificationJobQueued = false;

  if (isClassificationStricter(destClassification, source.classification)) {
    nextSourceClassification = destClassification;
  }

  // Update moved root parent_id, name, classification, depth, version (optimistic lock check)
  statements.push(
    db
      .prepare(
        `UPDATE folders
            SET parent_id = ?,
                name = ?,
                depth = depth + ?,
                classification = ?,
                version = version + 1,
                updated_at = ?
          WHERE tenant_id = ? AND id = ? AND version = ?`
      )
      .bind(
        targetParentId,
        resolvedName,
        depthDelta,
        nextSourceClassification,
        nowIso,
        user.tenantId,
        folderId,
        source.version
      )
  );

  // Update depths of strict descendants inside subtree cleanly in 1 SQL statement
  if (depthDelta !== 0) {
    statements.push(
      db
        .prepare(
          `UPDATE folders
              SET depth = depth + ?,
                  version = version + 1,
                  updated_at = ?
            WHERE tenant_id = ?
              AND id != ?
              AND id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )`
        )
        .bind(depthDelta, nowIso, user.tenantId, folderId, user.tenantId, folderId)
    );
  }

  // Elevate sensitivity across subtree folders/files when destination is stricter
  if (destClassification !== 'unset') {
    const targetStrictness = CLASSIFICATION_STRICTNESS[destClassification];
    const strictLabels = (['unset', 'public', 'internal', 'confidential'] as ClassificationLabel[]).filter(
      (label) => CLASSIFICATION_STRICTNESS[label] < targetStrictness
    );

    if (strictLabels.length > 0) {
      const placeholders = strictLabels.map(() => '?').join(', ');
      const countRow = await db
        .prepare(
          `SELECT (
             (SELECT COUNT(*) FROM folders
               WHERE tenant_id = ? AND id != ?
                 AND id IN (SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?)
                 AND classification IN (${placeholders}))
             +
             (SELECT COUNT(*) FROM files
               WHERE tenant_id = ? AND upload_state = 'active' AND deleted_at IS NULL
                 AND folder_id IN (SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?)
                 AND classification IN (${placeholders}))
           ) AS total_upgrades`
        )
        .bind(
          user.tenantId,
          folderId,
          user.tenantId,
          folderId,
          ...strictLabels,
          user.tenantId,
          user.tenantId,
          folderId,
          ...strictLabels
        )
        .first<{ total_upgrades: number }>();

      const totalUpgrades = countRow?.total_upgrades ?? 0;

      if (totalUpgrades > INLINE_CLASSIFICATION_PROPAGATION_LIMIT) {
        classificationJobQueued = true;
      } else if (totalUpgrades > 0) {
        const fileStatsRes = await db
          .prepare(
            `SELECT classification, COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS bytes
               FROM files
              WHERE tenant_id = ?
                AND upload_state = 'active'
                AND deleted_at IS NULL
                AND folder_id IN (
                  SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                )
                AND classification IN (${placeholders})
              GROUP BY classification`
          )
          .bind(user.tenantId, user.tenantId, folderId, ...strictLabels)
          .all<ClassificationStatsBucket>();

        statements.push(
          db
            .prepare(
              `UPDATE folders
                  SET classification = ?, updated_at = ?
                WHERE tenant_id = ? AND id != ?
                  AND id IN (
                    SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                  )
                  AND classification IN (${placeholders})`
            )
            .bind(
              destClassification,
              nowIso,
              user.tenantId,
              folderId,
              user.tenantId,
              folderId,
              ...strictLabels
            ),
          db
            .prepare(
              `UPDATE files
                  SET classification = ?,
                      meta_version = meta_version + 1,
                      classification_updated_by = ?,
                      classification_updated_at = ?,
                      updated_at = ?
                WHERE tenant_id = ?
                  AND upload_state = 'active'
                  AND deleted_at IS NULL
                  AND folder_id IN (
                    SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                  )
                  AND classification IN (${placeholders})`
            )
            .bind(
              destClassification,
              user.id,
              nowIso,
              nowIso,
              user.tenantId,
              user.tenantId,
              folderId,
              ...strictLabels
            ),
          // Keep files_fts synchronized for elevated active files
          db
            .prepare(
              `DELETE FROM files_fts
                WHERE file_id IN (
                  SELECT id FROM files
                   WHERE tenant_id = ? AND upload_state = 'active' AND deleted_at IS NULL
                     AND folder_id IN (
                       SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                     )
                )`
            )
            .bind(user.tenantId, user.tenantId, folderId),
          db
            .prepare(
              `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
               SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, '')
                 FROM files
                WHERE tenant_id = ? AND upload_state = 'active' AND deleted_at IS NULL
                  AND folder_id IN (
                    SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                  )`
            )
            .bind(user.tenantId, user.tenantId, folderId)
        );

        let addedCount = 0;
        let addedBytes = 0;
        for (const bucket of fileStatsRes.results) {
          addedCount += bucket.cnt;
          addedBytes += bucket.bytes;
          statements.push(
            db
              .prepare(
                `UPDATE tenant_storage_stats
                    SET file_count = MAX(0, file_count - ?),
                        total_bytes = MAX(0, total_bytes - ?),
                        updated_at = ?
                  WHERE tenant_id = ? AND classification = ?`
              )
              .bind(bucket.cnt, bucket.bytes, nowIso, user.tenantId, bucket.classification)
          );
        }
        if (addedCount > 0) {
          statements.push(
            db
              .prepare(
                `INSERT INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (tenant_id, classification)
                 DO UPDATE SET file_count = file_count + excluded.file_count,
                               total_bytes = total_bytes + excluded.total_bytes,
                               updated_at = excluded.updated_at`
              )
              .bind(user.tenantId, destClassification, addedCount, addedBytes, nowIso)
          );
        }
      }
    }
  }

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.move',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: nextSourceClassification,
      metadata: {
        fromParentId: source.parent_id,
        toParentId: targetParentId,
        depthDelta,
        classificationJobQueued,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: targetParentId,
      action: 'folder.move',
      payload: {
        fromParentId: source.parent_id,
        toParentId: targetParentId,
        name: resolvedName,
        depth: newRootDepth,
        classification: nextSourceClassification,
        version: source.version + 1,
        updatedAt: nowIso,
      },
      nowIso,
    })
  );

  if (source.parent_id !== null && source.parent_id !== targetParentId) {
    statements.push(
      buildSyncChangeStmt(db, {
        tenantId: user.tenantId,
        entityType: 'folder',
        entityId: folderId,
        folderId: source.parent_id,
        action: 'folder.moved_out',
        payload: {
          fromParentId: source.parent_id,
          updatedAt: nowIso,
        },
        nowIso,
      })
    );
  }

  await db.batch(statements);

  if (classificationJobQueued) {
    await queue.send({
      type: 'propagate_folder_classification',
      tenantId: user.tenantId,
      folderId,
      targetClassification: destClassification,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
    });
  }

  const updated = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();

  return {
    folder: updated!,
    classificationJobQueued,
  };
}

export async function softDeleteFolderSubtree(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  options?: { expectedVersion?: number }
): Promise<{ deletedAt: string; version: number }> {
  const access = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!access || access.deletedAt !== null) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Editor permission required to delete folder');
  }

  const existing = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!existing) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (
    options?.expectedVersion !== undefined &&
    existing.version !== options.expectedVersion
  ) {
    throw new FolderServiceError(
      409,
      'VERSION_CONFLICT',
      `Folder version mismatch (expected ${options.expectedVersion}, actual ${existing.version})`,
      existing
    );
  }

  const nowIso = new Date().toISOString();

  // Order matters inside batch: remove active files from FTS5 before stamping deleted_at
  await db.batch([
    db
      .prepare(
        `DELETE FROM files_fts
          WHERE file_id IN (
            SELECT id FROM files
             WHERE tenant_id = ?
               AND deleted_at IS NULL
               AND folder_id IN (
                 SELECT descendant_id
                   FROM folder_closures
                  WHERE tenant_id = ? AND ancestor_id = ?
               )
          )`
      )
      .bind(user.tenantId, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE files
            SET deleted_at = ?, meta_version = meta_version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND folder_id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, nowIso, user.tenantId, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE folders
            SET deleted_at = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, nowIso, user.tenantId, user.tenantId, folderId),
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.soft_delete',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: access.classification,
      metadata: { deletedAt: nowIso },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: existing.parent_id,
      action: 'folder.soft_delete',
      payload: {
        parentId: existing.parent_id,
        deletedAt: nowIso,
        version: existing.version + 1,
      },
      nowIso,
    }),
  ]);

  return { deletedAt: nowIso, version: existing.version + 1 };
}

export async function restoreFolderSubtree(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  conflictPolicy: 'fail' | 'rename' = 'fail'
): Promise<{ folder: FolderRow; restoredAt: string }> {
  const access = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!access) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (access.deletedAt === null) {
    throw new FolderServiceError(400, 'NOT_IN_TRASH', 'Folder is not in Trash');
  }
  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Editor permission required to restore folder');
  }

  const folder = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!folder || !folder.deleted_at) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }

  if (folder.parent_id !== null) {
    const parent = await db
      .prepare('SELECT id, deleted_at FROM folders WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, folder.parent_id)
      .first<{ id: string; deleted_at: string | null }>();
    if (!parent || parent.deleted_at !== null) {
      throw new FolderServiceError(
        409,
        'PARENT_IN_TRASH',
        'Parent folder must be restored before restoring this folder'
      );
    }
  }

  let nextName = folder.name;
  const hasConflict = await hasDuplicateFolderName(
    db,
    user.tenantId,
    folder.parent_id,
    folder.name,
    folder.id
  );
  if (hasConflict) {
    if (conflictPolicy !== 'rename') {
      throw new FolderServiceError(
        409,
        'NAME_CONFLICT',
        `An active folder named "${folder.name}" already exists in this location`
      );
    }
    nextName = await resolveUniqueRestoredName(
      db,
      user.tenantId,
      folder.parent_id,
      folder.name
    );
  }

  const batchDeletedAt = folder.deleted_at;
  const nowIso = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    // Re-index active restored files matching exact deleted_at BEFORE clearing deleted_at
    db
      .prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, '')
           FROM files
          WHERE tenant_id = ?
            AND upload_state = 'active'
            AND deleted_at = ?
            AND folder_id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(user.tenantId, batchDeletedAt, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE files
            SET deleted_at = NULL, meta_version = meta_version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at = ?
            AND folder_id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, user.tenantId, batchDeletedAt, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE folders
            SET deleted_at = NULL,
                name = CASE WHEN id = ? THEN ? ELSE name END,
                version = version + 1,
                updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at = ?
            AND id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(folderId, nextName, nowIso, user.tenantId, batchDeletedAt, user.tenantId, folderId),
  ];

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.restore',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: {
        restoredBatchDeletedAt: batchDeletedAt,
        renamedTo: nextName !== folder.name ? nextName : null,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: folder.parent_id,
      action: 'folder.restore',
      payload: {
        folder: {
          ...folder,
          name: nextName,
          deleted_at: null,
          version: folder.version + 1,
          updated_at: nowIso,
        },
      },
      nowIso,
    })
  );

  await db.batch(statements);

  const restored = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();

  return { folder: restored!, restoredAt: nowIso };
}
