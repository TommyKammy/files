import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import { resolveTargetAccess } from '../../../services/authorization';
import {
  DEFAULT_SHARE_LINK_POLICY,
  getShareLinkPolicyFlags,
  resolveEffectiveShareCapabilities,
} from '../../../services/shared-link-permissions';
import { buildZipArchive, sanitizeZipPath, type ZipEntryInput } from '../../../services/zip-builder';
import type { ClassificationLabel } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import { chunkArray } from '../../../utils/batch';
import {
  buildZipAttachmentDisposition,
  MAX_ZIP_BYTES,
  MAX_ZIP_FILES,
} from '../../workspace-zip';
import { getClientIp, hasConfidentialAncestor, ShareTargetFolderRow } from '../shared';
import { loadAndAuthorizeShareLink, verifyShareLinkUnlock } from './public-shared';

interface DescendantFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  depth: number;
}

interface SharedFolderFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  size_bytes: number;
  classification: ClassificationLabel;
  updated_at: string | null;
  r2_object_key: string | null;
}

export function registerPublicShareZipRoutes(routes: Hono<OidcHonoEnv>) {
  routes.get('/:token/zip', async (c) => {
    const user = c.get('user');
    const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }
    const { link, tokenHash } = auth;

    const unlockCheck = await verifyShareLinkUnlock(c, link, tokenHash);
    if (!unlockCheck.ok) {
      return c.json(unlockCheck.body, unlockCheck.status);
    }

    if (link.target_type !== 'folder') {
      return c.json(
        { error: 'ZIP download is only supported for folder shared links', code: 'NOT_A_FOLDER_LINK' },
        400
      );
    }

    const rootFolder = await c.env.DB.prepare(
      'SELECT id, name, classification, deleted_at FROM folders WHERE tenant_id = ? AND id = ?'
    )
      .bind(link.tenant_id, link.target_id)
      .first<ShareTargetFolderRow>();
    if (!rootFolder || rootFolder.deleted_at !== null) {
      return c.json({ error: 'Shared folder is no longer available', code: 'TARGET_UNAVAILABLE' }, 404);
    }

    const rawFolderId = c.req.query('folderId')?.trim();
    const targetFolderId = rawFolderId && rawFolderId.length > 0 ? rawFolderId : rootFolder.id;

    let activeFolder = rootFolder;
    if (targetFolderId !== rootFolder.id) {
      const descendant = await c.env.DB.prepare(
        `SELECT f.id, f.name, f.classification, f.deleted_at
         FROM folder_closures fc
         JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
         WHERE fc.tenant_id = ?
           AND fc.ancestor_id = ?
           AND fc.descendant_id = ?
           AND f.deleted_at IS NULL`
      )
        .bind(link.tenant_id, rootFolder.id, targetFolderId)
        .first<ShareTargetFolderRow>();
      if (!descendant) {
        return c.json({ error: 'Shared subfolder not found', code: 'SUBFOLDER_NOT_FOUND' }, 404);
      }
      activeFolder = descendant;
    }

    const clientIp = getClientIp(c.req, user);
    const nowIso = new Date().toISOString();

    const [policy, ancestorConfidential, collaboratorAccess] = await Promise.all([
      getShareLinkPolicyFlags(c.env.DB, link.tenant_id).catch(() => ({
        ...DEFAULT_SHARE_LINK_POLICY,
      })),
      hasConfidentialAncestor(c.env.DB, link.tenant_id, activeFolder.id),
      user ? resolveTargetAccess(c.env.DB, user, link.target_type, link.target_id) : null,
    ]);

    const isConfidential =
      activeFolder.classification === 'confidential' || ancestorConfidential;
    const effective = resolveEffectiveShareCapabilities({
      link,
      collaboratorCapabilities: collaboratorAccess?.capabilities ?? null,
      user,
      policy,
      isConfidential,
    });

    if (!effective.canDownload || isConfidential) {
      await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: link.tenant_id,
          actorId: user?.id ?? null,
          actorEmail: user?.email ?? null,
          actorIp: clientIp,
          action: 'shared_link.download_blocked',
          targetType: 'folder',
          targetId: activeFolder.id,
          classificationSnapshot: activeFolder.classification,
          status: 'blocked',
          metadata: {
            linkId: link.id,
            permissionLevel: effective.permissionLevel,
            reason: isConfidential ? 'confidential_zip_blocked' : 'can_download_disabled',
          },
          nowIso,
        }),
      ]);
      return c.json(
        { error: 'Downloads are disabled for this shared link', code: 'DOWNLOAD_DISABLED' },
        403
      );
    }

    // Collect non-deleted descendant folders (skipping any confidential subtrees)
    const descendants = await c.env.DB.prepare(
      `SELECT f.id, f.parent_id, f.name, f.classification, fc.depth
       FROM folder_closures fc
       JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
       WHERE fc.tenant_id = ? AND fc.ancestor_id = ? AND f.deleted_at IS NULL
       ORDER BY fc.depth ASC, f.name ASC`
    )
      .bind(link.tenant_id, activeFolder.id)
      .all<DescendantFolderRow>();

    const folderPathMap = new Map<string, string>();
    let skippedConfidentialCount = 0;

    for (const row of descendants.results) {
      if (row.classification === 'confidential') {
        skippedConfidentialCount++;
        continue;
      }
      if (row.depth === 0) {
        folderPathMap.set(row.id, sanitizeZipPath(row.name));
      } else if (row.parent_id && folderPathMap.has(row.parent_id)) {
        folderPathMap.set(
          row.id,
          `${folderPathMap.get(row.parent_id)!}/${sanitizeZipPath(row.name)}`
        );
      }
    }

    const candidates: Array<{
      id: string;
      archivePath: string;
      sizeBytes: number;
      r2ObjectKey: string;
      updatedAt: string | null;
    }> = [];

    for (const chunk of chunkArray([...folderPathMap.keys()], 40)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const filesRes = await c.env.DB.prepare(
        `SELECT f.id, f.folder_id, f.name, f.size_bytes, f.classification, f.updated_at, fv.r2_object_key
         FROM files f
         JOIN file_versions fv ON fv.id = f.current_version_id
         WHERE f.tenant_id = ?
           AND f.folder_id IN (${placeholders})
           AND f.deleted_at IS NULL
           AND f.upload_state = 'active'
         ORDER BY f.name ASC`
      )
        .bind(link.tenant_id, ...chunk)
        .all<SharedFolderFileRow>();

      for (const f of filesRes.results) {
        if (!f.r2_object_key) continue;
        if (f.classification === 'confidential') {
          skippedConfidentialCount++;
          continue;
        }
        const dirPath = f.folder_id ? folderPathMap.get(f.folder_id) ?? '' : '';
        candidates.push({
          id: f.id,
          archivePath: dirPath
            ? `${dirPath}/${sanitizeZipPath(f.name)}`
            : sanitizeZipPath(f.name),
          sizeBytes: f.size_bytes,
          r2ObjectKey: f.r2_object_key,
          updatedAt: f.updated_at,
        });
      }
    }

    if (candidates.length === 0) {
      return c.json(
        {
          error: 'ダウンロード可能なファイルがありません',
          code: skippedConfidentialCount > 0 ? 'DOWNLOAD_DISABLED' : 'NO_DOWNLOADABLE_FILES',
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

    // Atomic download count check & increment
    const incremented = await c.env.DB.prepare(
      `UPDATE shared_links
       SET download_count = download_count + 1
       WHERE tenant_id = ?
         AND id = ?
         AND revoked_at IS NULL
         AND can_download = 1
         AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
         AND (max_downloads IS NULL OR download_count < max_downloads)
       RETURNING download_count`
    )
      .bind(link.tenant_id, link.id, nowIso)
      .first<{ download_count: number }>();

    if (!incremented) {
      await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: link.tenant_id,
          actorId: user?.id ?? null,
          actorEmail: user?.email ?? null,
          actorIp: clientIp,
          action: 'shared_link.download_limit_exceeded',
          targetType: 'folder',
          targetId: activeFolder.id,
          classificationSnapshot: activeFolder.classification,
          status: 'blocked',
          metadata: { linkId: link.id, maxDownloads: link.max_downloads },
          nowIso,
        }),
      ]);
      return c.json(
        { error: 'Shared link download limit exceeded or link no longer active', code: 'DOWNLOAD_LIMIT_EXCEEDED' },
        403
      );
    }

    const zipEntries: ZipEntryInput[] = [];
    let actualTotalBytes = 0;
    for (const candidate of candidates) {
      const obj = await c.env.BUCKET.get(candidate.r2ObjectKey);
      if (!obj) {
        return c.json(
          { error: 'Shared file storage object not found', code: 'TARGET_UNAVAILABLE' },
          404
        );
      }
      const data = new Uint8Array(await obj.arrayBuffer());
      actualTotalBytes += data.byteLength;
      if (actualTotalBytes > MAX_ZIP_BYTES) {
        return c.json(
          {
            error: 'ZIPダウンロードの上限（最大100ファイル / 100MB）を超えています。',
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
        tenantId: link.tenant_id,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        actorIp: clientIp,
        action: 'shared_link.download_zip',
        targetType: 'folder',
        targetId: activeFolder.id,
        classificationSnapshot: activeFolder.classification,
        status: 'allowed',
        metadata: {
          linkId: link.id,
          permissionLevel: effective.permissionLevel,
          fileCount: zipEntries.length,
          totalBytes: actualTotalBytes,
          downloadCount: incremented.download_count,
          skippedConfidentialCount,
        },
        nowIso,
      }),
    ]);

    return new Response(zipBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': buildZipAttachmentDisposition(`${activeFolder.name}.zip`),
        'Content-Length': String(zipBytes.byteLength),
        'X-Download-Count': String(incremented.download_count),
        'Cache-Control': 'no-store',
      },
    });
  });
}
