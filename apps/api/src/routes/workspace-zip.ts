import { Hono } from 'hono';
import { buildAuditLogStmt } from '../services/audit';
import { getAuthenticatedUser, resolveTargetAccess } from '../services/authorization';
import { can } from '../services/capabilities';
import { dedupeBatchItems, WorkspaceOpError } from '../services/workspace/shared';
import { buildZipArchive, sanitizeZipPath, type ZipEntryInput } from '../services/zip-builder';
import type { OidcHonoEnv } from '../types/oidc';
import { chunkArray } from '../utils/batch';

export const MAX_ZIP_FILES = 100;
export const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MiB

export function buildZipAttachmentDisposition(rawName: string): string {
  const safeBase = sanitizeZipPath(rawName).replace(/\//g, '_');
  const finalName = safeBase.toLowerCase().endsWith('.zip') ? safeBase : `${safeBase}.zip`;
  const asciiFallback = finalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download.zip';
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(finalName)}`;
}

interface ZipCandidateFile {
  id: string;
  archivePath: string;
  sizeBytes: number;
  r2ObjectKey: string;
  updatedAt: string | null;
}

interface DescendantFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  depth: number;
}

interface FileVersionJoinRow {
  id: string;
  folder_id: string | null;
  name: string;
  size_bytes: number;
  updated_at: string | null;
  r2_object_key: string | null;
}

export const workspaceZipRoutes = new Hono<OidcHonoEnv>();

workspaceZipRoutes.post('/download-zip', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as { items?: unknown } | null;

  let requestedItems;
  try {
    requestedItems = dedupeBatchItems(body?.items);
  } catch (err) {
    if (err instanceof WorkspaceOpError) {
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    throw err;
  }

  const nowIso = new Date().toISOString();
  const seenFileIds = new Set<string>();
  const candidates: ZipCandidateFile[] = [];
  let skippedForbiddenCount = 0;
  let singleLabel: string | null = null;

  for (const item of requestedItems) {
    const access = await resolveTargetAccess(c.env.DB, user, item.type, item.id);
    if (
      !access ||
      access.deletedAt !== null ||
      (item.type === 'file' && access.uploadState !== 'active')
    ) {
      return c.json(
        { error: '指定されたアイテムが見つかりません', code: 'ITEM_NOT_FOUND' },
        404
      );
    }

    if (item.type === 'file') {
      if (!can(access.capabilities, 'item.download')) {
        await c.env.DB.batch([
          buildAuditLogStmt(c.env.DB, {
            tenantId: user.tenantId,
            actorId: user.id,
            actorEmail: user.email,
            actorIp: user.ipAddress,
            action: 'workspace.download_zip',
            targetType: 'file',
            targetId: item.id,
            classificationSnapshot: access.classification,
            status: 'blocked',
            metadata: { reason: 'missing_item_download_capability', effectiveRole: access.effectiveRole },
            nowIso,
          }),
        ]);
        return c.json(
          { error: 'ダウンロード権限がありません', code: 'DOWNLOAD_FORBIDDEN' },
          403
        );
      }

      if (seenFileIds.has(item.id)) continue;
      const row = await c.env.DB.prepare(
        `SELECT f.id, f.folder_id, f.name, f.size_bytes, f.updated_at, fv.r2_object_key
         FROM files f
         JOIN file_versions fv ON fv.id = f.current_version_id
         WHERE f.tenant_id = ? AND f.id = ? AND f.deleted_at IS NULL AND f.upload_state = 'active'`
      )
        .bind(user.tenantId, item.id)
        .first<FileVersionJoinRow>();

      if (!row || !row.r2_object_key) {
        return c.json(
          { error: 'ファイルの実体が見つかりません', code: 'ITEM_NOT_FOUND' },
          404
        );
      }

      seenFileIds.add(row.id);
      if (requestedItems.length === 1) singleLabel = row.name;
      candidates.push({
        id: row.id,
        archivePath: sanitizeZipPath(row.name),
        sizeBytes: row.size_bytes,
        r2ObjectKey: row.r2_object_key,
        updatedAt: row.updated_at,
      });
    } else {
      if (!can(access.capabilities, 'folder.list') || !can(access.capabilities, 'item.download')) {
        await c.env.DB.batch([
          buildAuditLogStmt(c.env.DB, {
            tenantId: user.tenantId,
            actorId: user.id,
            actorEmail: user.email,
            actorIp: user.ipAddress,
            action: 'workspace.download_zip',
            targetType: 'folder',
            targetId: item.id,
            classificationSnapshot: access.classification,
            status: 'blocked',
            metadata: { reason: 'missing_folder_download_capability', effectiveRole: access.effectiveRole },
            nowIso,
          }),
        ]);
        return c.json(
          { error: 'このフォルダをダウンロードする権限がありません', code: 'DOWNLOAD_FORBIDDEN' },
          403
        );
      }

      const descendants = await c.env.DB.prepare(
        `SELECT f.id, f.parent_id, f.name, fc.depth
         FROM folder_closures fc
         JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
         WHERE fc.tenant_id = ? AND fc.ancestor_id = ? AND f.deleted_at IS NULL
         ORDER BY fc.depth ASC, f.name ASC`
      )
        .bind(user.tenantId, item.id)
        .all<DescendantFolderRow>();

      const folderPathMap = new Map<string, string>();
      for (const folderRow of descendants.results) {
        if (folderRow.depth === 0) {
          folderPathMap.set(folderRow.id, sanitizeZipPath(folderRow.name));
          if (requestedItems.length === 1) singleLabel = folderRow.name;
        } else if (folderRow.parent_id && folderPathMap.has(folderRow.parent_id)) {
          folderPathMap.set(
            folderRow.id,
            `${folderPathMap.get(folderRow.parent_id)!}/${sanitizeZipPath(folderRow.name)}`
          );
        }
      }

      const folderIds = [...folderPathMap.keys()];
      const folderFiles: FileVersionJoinRow[] = [];
      for (const chunk of chunkArray(folderIds, 40)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const res = await c.env.DB.prepare(
          `SELECT f.id, f.folder_id, f.name, f.size_bytes, f.updated_at, fv.r2_object_key
           FROM files f
           JOIN file_versions fv ON fv.id = f.current_version_id
           WHERE f.tenant_id = ?
             AND f.folder_id IN (${placeholders})
             AND f.deleted_at IS NULL
             AND f.upload_state = 'active'
           ORDER BY f.name ASC`
        )
          .bind(user.tenantId, ...chunk)
          .all<FileVersionJoinRow>();
        folderFiles.push(...res.results);
      }

      for (const chunk of chunkArray(folderFiles, 20)) {
        const accesses = await Promise.all(
          chunk.map((f) => resolveTargetAccess(c.env.DB, user, 'file', f.id))
        );
        for (let i = 0; i < chunk.length; i++) {
          const f = chunk[i]!;
          const fileAccess = accesses[i];
          if (seenFileIds.has(f.id) || !f.r2_object_key) continue;
          if (!fileAccess || !can(fileAccess.capabilities, 'item.download')) {
            skippedForbiddenCount++;
            continue;
          }
          seenFileIds.add(f.id);
          const parentPath = f.folder_id ? folderPathMap.get(f.folder_id) ?? '' : '';
          candidates.push({
            id: f.id,
            archivePath: parentPath
              ? `${parentPath}/${sanitizeZipPath(f.name)}`
              : sanitizeZipPath(f.name),
            sizeBytes: f.size_bytes,
            r2ObjectKey: f.r2_object_key,
            updatedAt: f.updated_at,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    await c.env.DB.batch([
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'workspace.download_zip',
        targetType: requestedItems[0]!.type,
        targetId: requestedItems[0]!.id,
        status: 'blocked',
        metadata: {
          reason: skippedForbiddenCount > 0 ? 'all_files_forbidden' : 'no_downloadable_files',
          skippedForbiddenCount,
        },
        nowIso,
      }),
    ]);
    return c.json(
      {
        error: 'ダウンロード可能なファイルがありません',
        code: skippedForbiddenCount > 0 ? 'DOWNLOAD_FORBIDDEN' : 'NO_DOWNLOADABLE_FILES',
      },
      403
    );
  }

  const declaredTotalBytes = candidates.reduce((sum, f) => sum + f.sizeBytes, 0);
  if (candidates.length > MAX_ZIP_FILES || declaredTotalBytes > MAX_ZIP_BYTES) {
    return c.json(
      {
        error: 'ZIPダウンロードの上限（最大100ファイル / 100MB）を超えています。対象を絞って再度お試しください。',
        code: 'ZIP_LIMIT_EXCEEDED',
        maxFiles: MAX_ZIP_FILES,
        maxBytes: MAX_ZIP_BYTES,
        actualFiles: candidates.length,
        actualBytes: declaredTotalBytes,
      },
      413
    );
  }

  const zipEntries: ZipEntryInput[] = [];
  let actualTotalBytes = 0;
  for (const candidate of candidates) {
    const obj = await c.env.BUCKET.get(candidate.r2ObjectKey);
    if (!obj) {
      return c.json(
        { error: 'ストレージ上のファイルが見つかりません', code: 'STORAGE_OBJECT_MISSING' },
        404
      );
    }
    const data = new Uint8Array(await obj.arrayBuffer());
    actualTotalBytes += data.byteLength;
    if (actualTotalBytes > MAX_ZIP_BYTES) {
      return c.json(
        {
          error: 'ZIPダウンロードの上限（最大100ファイル / 100MB）を超えています。対象を絞って再度お試しください。',
          code: 'ZIP_LIMIT_EXCEEDED',
          maxFiles: MAX_ZIP_FILES,
          maxBytes: MAX_ZIP_BYTES,
          actualFiles: candidates.length,
          actualBytes: actualTotalBytes,
        },
        413
      );
    }
    zipEntries.push({
      path: candidate.archivePath,
      data,
      lastModified: candidate.updatedAt ? new Date(candidate.updatedAt) : undefined,
    });
  }

  const zipBytes = buildZipArchive(zipEntries);

  await c.env.DB.batch([
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'workspace.download_zip',
      targetType: requestedItems[0]!.type,
      targetId: requestedItems[0]!.id,
      status: 'allowed',
      metadata: {
        requestedItemCount: requestedItems.length,
        fileCount: zipEntries.length,
        totalBytes: actualTotalBytes,
        skippedForbiddenCount,
      },
      nowIso,
    }),
  ]);

  const zipFilename = singleLabel ? `${singleLabel}.zip` : 'workspace-download.zip';
  return new Response(zipBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': buildZipAttachmentDisposition(zipFilename),
      'Content-Length': String(zipBytes.byteLength),
      'Cache-Control': 'no-store',
    },
  });
});
