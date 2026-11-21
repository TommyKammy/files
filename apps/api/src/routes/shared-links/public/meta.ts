import { Hono } from 'hono';
import { resolveTargetAccess } from '../../../services/authorization';
import { loadTenantBranding } from '../../../services/branding';
import {
  DEFAULT_SHARE_LINK_POLICY,
  getShareLinkPolicyFlags,
  resolveEffectiveShareCapabilities,
} from '../../../services/shared-link-permissions';
import { getShareUnlockSecret, verifyShareUnlockToken } from '../../../services/shared-link-security';
import type { ClassificationLabel } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import {
  ShareTargetFileRow,
  ShareTargetFolderRow,
  hasConfidentialAncestor,
} from '../shared';
import {
  loadAndAuthorizeShareLink,
  readUnlockToken,
} from './public-shared';

export function registerPublicShareMetaRoutes(routes: Hono<OidcHonoEnv>) {
  routes.get('/:token/meta', async (c) => {
    const user = c.get('user');
    const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }
    const { link, tokenHash } = auth;

    let unlocked = true;
    if (link.password_hash) {
      const unlockSecret = getShareUnlockSecret(c.env);
      unlocked = await verifyShareUnlockToken(
        unlockSecret,
        readUnlockToken(c, link.id),
        link.id,
        tokenHash
      );
    }

    let fileMeta: {
      id: string;
      name: string;
      extension: string | null;
      mimeType: string | null;
      sizeBytes: number;
      classification: ClassificationLabel;
    } | null = null;
    let folderMeta: { id: string; name: string; classification: ClassificationLabel } | null = null;
    let currentFolder: { id: string; name: string; classification: ClassificationLabel } | null = null;
    let subfolders: Array<{
      id: string;
      name: string;
      classification: ClassificationLabel;
    }> = [];
    let breadcrumbs: Array<{ id: string; name: string }> = [];
    let folderFiles: Array<{
      id: string;
      name: string;
      extension: string | null;
      mimeType: string | null;
      sizeBytes: number;
      classification: ClassificationLabel;
    }> = [];
    let targetClassification: ClassificationLabel = 'unset';
    let targetFolderId: string | null = link.target_type === 'folder' ? link.target_id : null;

    if (link.target_type === 'file') {
      const file = await c.env.DB.prepare(
        `SELECT id, name, extension, mime_type, size_bytes, classification, upload_state, deleted_at
         FROM files WHERE tenant_id = ? AND id = ?`
      )
        .bind(link.tenant_id, link.target_id)
        .first<ShareTargetFileRow>();
      if (!file || file.deleted_at !== null || file.upload_state !== 'active') {
        return c.json({ error: 'Shared file is no longer available', code: 'TARGET_UNAVAILABLE' }, 404);
      }
      targetClassification = file.classification;
      targetFolderId = null;
      const fileFolder = await c.env.DB.prepare(
        'SELECT folder_id FROM files WHERE tenant_id = ? AND id = ?'
      )
        .bind(link.tenant_id, file.id)
        .first<{ folder_id: string | null }>();
      targetFolderId = fileFolder?.folder_id ?? null;
      if (unlocked) {
        fileMeta = {
          id: file.id,
          name: file.name,
          extension: file.extension,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          classification: file.classification,
        };
      }
    } else {
      const folder = await c.env.DB.prepare(
        'SELECT id, name, classification, deleted_at FROM folders WHERE tenant_id = ? AND id = ?'
      )
        .bind(link.tenant_id, link.target_id)
        .first<ShareTargetFolderRow>();
      if (!folder || folder.deleted_at !== null) {
        return c.json({ error: 'Shared folder is no longer available', code: 'TARGET_UNAVAILABLE' }, 404);
      }
      targetClassification = folder.classification;
      targetFolderId = folder.id;
      if (unlocked) {
        folderMeta = {
          id: folder.id,
          name: folder.name,
          classification: folder.classification,
        };
        const rawRequestedFolderId = c.req.query('folderId')?.trim();
        const requestedFolderId =
          rawRequestedFolderId && rawRequestedFolderId.length > 0
            ? rawRequestedFolderId
            : folder.id;

        let activeFolder = folder;
        if (requestedFolderId !== folder.id) {
          const descendant = await c.env.DB.prepare(
            `SELECT f.id, f.name, f.classification, f.deleted_at
             FROM folder_closures fc
             JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
             WHERE fc.tenant_id = ?
               AND fc.ancestor_id = ?
               AND fc.descendant_id = ?
               AND f.deleted_at IS NULL`
          )
            .bind(link.tenant_id, folder.id, requestedFolderId)
            .first<ShareTargetFolderRow>();
          if (!descendant) {
            return c.json(
              { error: 'Shared subfolder not found', code: 'SUBFOLDER_NOT_FOUND' },
              404
            );
          }
          activeFolder = descendant;
          targetClassification = activeFolder.classification;
          targetFolderId = activeFolder.id;
        }

        currentFolder = {
          id: activeFolder.id,
          name: activeFolder.name,
          classification: activeFolder.classification,
        };

        const [listedSubfolders, listedFiles, listedBreadcrumbs] = await Promise.all([
          c.env.DB.prepare(
            `SELECT id, name, classification
             FROM folders
             WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL
             ORDER BY name ASC LIMIT 200`
          )
            .bind(link.tenant_id, activeFolder.id)
            .all<{ id: string; name: string; classification: ClassificationLabel }>(),
          c.env.DB.prepare(
            `SELECT id, name, extension, mime_type, size_bytes, classification
             FROM files
             WHERE tenant_id = ? AND folder_id = ? AND upload_state = 'active' AND deleted_at IS NULL
             ORDER BY name ASC LIMIT 200`
          )
            .bind(link.tenant_id, activeFolder.id)
            .all<{
              id: string;
              name: string;
              extension: string | null;
              mime_type: string | null;
              size_bytes: number;
              classification: ClassificationLabel;
            }>(),
          c.env.DB.prepare(
            `SELECT f.id, f.name
             FROM folder_closures fc_cur
             JOIN folder_closures fc_root
               ON fc_root.tenant_id = fc_cur.tenant_id
              AND fc_root.ancestor_id = ?
              AND fc_root.descendant_id = fc_cur.ancestor_id
             JOIN folders f
               ON f.tenant_id = fc_cur.tenant_id
              AND f.id = fc_cur.ancestor_id
              AND f.deleted_at IS NULL
             WHERE fc_cur.tenant_id = ?
               AND fc_cur.descendant_id = ?
             ORDER BY fc_cur.depth DESC`
          )
            .bind(folder.id, link.tenant_id, activeFolder.id)
            .all<{ id: string; name: string }>(),
        ]);

        subfolders = listedSubfolders.results.map((sf) => ({
          id: sf.id,
          name: sf.name,
          classification: sf.classification,
        }));
        folderFiles = listedFiles.results.map((f) => ({
          id: f.id,
          name: f.name,
          extension: f.extension,
          mimeType: f.mime_type,
          sizeBytes: f.size_bytes,
          classification: f.classification,
        }));
        breadcrumbs = listedBreadcrumbs.results.map((b) => ({
          id: b.id,
          name: b.name,
        }));
      }
    }

    const [policy, ancestorConfidential, collaboratorAccess] = await Promise.all([
      getShareLinkPolicyFlags(c.env.DB, link.tenant_id).catch(() => ({
        ...DEFAULT_SHARE_LINK_POLICY,
      })),
      hasConfidentialAncestor(c.env.DB, link.tenant_id, targetFolderId),
      user ? resolveTargetAccess(c.env.DB, user, link.target_type, link.target_id) : null,
    ]);
    const branding = await loadTenantBranding(c.env.DB, link.tenant_id);
    const isConfidential =
      targetClassification === 'confidential' || ancestorConfidential;
    const effective = resolveEffectiveShareCapabilities({
      link,
      collaboratorCapabilities: collaboratorAccess?.capabilities ?? null,
      user,
      policy,
      isConfidential,
    });

    const nowMs = Date.now();
    return c.json({
      targetType: link.target_type,
      accessScope: link.access_scope,
      permissionLevel: effective.permissionLevel,
      canDownload: effective.canDownload,
      canEdit: effective.canEdit,
      composedRole: effective.composedRole,
      composedCapabilities: effective.composedCapabilities,
      requiresAuthForEdit: effective.requiresAuthForEdit,
      anonymousEditBlocked: effective.anonymousEditBlocked,
      editDisabledByPolicy: effective.editDisabledByPolicy,
      requireWatermark: effective.requireWatermark || link.require_watermark === 1,
      requiresPassword: Boolean(link.password_hash),
      unlocked,
      isLocked: Boolean(link.locked_until && Date.parse(link.locked_until) > nowMs),
      lockedUntil: link.locked_until,
      expiresAt: link.expires_at,
      maxDownloads: link.max_downloads,
      downloadCount: link.download_count,
      file: fileMeta,
      folder: folderMeta,
      currentFolder,
      subfolders,
      breadcrumbs,
      folderFiles,
      branding,
    });
  });
}
