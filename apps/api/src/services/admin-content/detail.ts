import type { FileLockSnapshot } from '../../durable-objects/file-lock-hub';
import type { ClassificationLabel, ShareAccessScope } from '../../types/api';
import type { OidcEnv } from '../../types/oidc';
import {
  buildActiveFileLockDeleteStmt,
  buildActiveFileLockUpsertStmt,
} from '../active-file-lock-index';
import { getFileLockState } from '../file-lock';
import {
  folderPathLabel,
  loadFolderBreadcrumbMap,
  type FolderBreadcrumb,
} from '../folder-breadcrumbs';
import { resolvePermissionLevel } from '../shared-link-permissions';
import {
  getAdminContentInspectPolicy,
  type AdminContentInspectPolicy,
  type AdminContentOwner,
  type AdminContentTargetType,
} from './shared';

interface AdminContentDetailRow {
  id: string;
  tenant_id: string;
  folder_id: string | null;
  parent_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  classification: ClassificationLabel;
  current_version_id: string | null;
  current_version_num: number | null;
  created_by: string;
  updated_at: string;
  created_at: string;
  owner_email: string | null;
  owner_display_name: string | null;
}

export interface AdminContentPermissionItem {
  id: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string | null;
  granteeEmail: string | null;
  role: string;
  grantedBy: string;
  grantedByEmail: string | null;
  createdAt: string;
}

export interface AdminContentSharedLinkItem {
  id: string;
  targetType: AdminContentTargetType;
  targetId: string;
  accessScope: string;
  permissionLevel: 'view' | 'download' | 'edit';
  canDownload: boolean;
  requireWatermark: boolean;
  hasPassword: boolean;
  isLocked: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdBy: string;
  creatorEmail: string | null;
  createdAt: string;
}

export interface AdminContentVersionItem {
  id: string;
  versionNum: number;
  sizeBytes: number;
  mimeType: string;
  uploadStatus: string;
  uploadedBy: string;
  uploadedByEmail: string | null;
  comment: string | null;
  createdAt: string;
}

export interface AdminContentDetail {
  targetType: AdminContentTargetType;
  id: string;
  name: string;
  folderId: string | null;
  parentId: string | null;
  pathLabel: string;
  breadcrumbs: FolderBreadcrumb[];
  owner: AdminContentOwner;
  classification: ClassificationLabel;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  currentVersionId: string | null;
  currentVersionNum: number | null;
  createdAt: string;
  updatedAt: string;
  activeLock: FileLockSnapshot | null;
  permissions: AdminContentPermissionItem[];
  sharedLinks: AdminContentSharedLinkItem[];
  versions: {
    total: number;
    items: AdminContentVersionItem[];
  };
  inspectPolicy: AdminContentInspectPolicy;
}

interface PermissionRow {
  id: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  grantee_name: string | null;
  grantee_email: string | null;
  role: string;
  granted_by: string;
  granted_by_email: string | null;
  created_at: string;
}

interface SharedLinkDetailRow {
  id: string;
  target_type: AdminContentTargetType;
  target_id: string;
  access_scope: string;
  permission_level: string;
  can_download: number;
  require_watermark: number;
  password_hash: string | null;
  locked_until: string | null;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  created_by: string;
  creator_email: string | null;
  created_at: string;
}

interface VersionRow {
  id: string;
  version_num: number;
  size_bytes: number;
  mime_type: string;
  upload_status: string;
  uploaded_by: string;
  uploaded_by_email: string | null;
  comment: string | null;
  created_at: string;
}

export async function getAdminContentDetail(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  targetType: AdminContentTargetType,
  targetId: string
): Promise<AdminContentDetail | null> {
  if (targetType === 'file') {
    const row = await env.DB.prepare(
      `SELECT fl.id, fl.tenant_id, fl.folder_id, NULL AS parent_id, fl.name,
              fl.extension, fl.mime_type, fl.size_bytes, fl.classification,
              fl.current_version_id, fl.current_version_num, fl.created_by,
              fl.updated_at, fl.created_at,
              u.email AS owner_email, u.display_name AS owner_display_name
         FROM files fl
         LEFT JOIN users u
           ON u.tenant_id = fl.tenant_id AND u.id = fl.created_by
        WHERE fl.tenant_id = ? AND fl.id = ?
          AND fl.deleted_at IS NULL AND fl.upload_state = 'active'`
    )
      .bind(tenantId, targetId)
      .first<AdminContentDetailRow>();
    if (!row) return null;
    return assembleAdminContentDetail(env, tenantId, 'file', row);
  }

  const row = await env.DB.prepare(
    `SELECT fo.id, fo.tenant_id, fo.parent_id AS folder_id, fo.parent_id,
            fo.name, NULL AS extension, NULL AS mime_type, NULL AS size_bytes,
            fo.classification, NULL AS current_version_id,
            NULL AS current_version_num, fo.created_by, fo.updated_at,
            fo.created_at,
            u.email AS owner_email, u.display_name AS owner_display_name
       FROM folders fo
       LEFT JOIN users u
         ON u.tenant_id = fo.tenant_id AND u.id = fo.created_by
      WHERE fo.tenant_id = ? AND fo.id = ? AND fo.deleted_at IS NULL`
  )
    .bind(tenantId, targetId)
    .first<AdminContentDetailRow>();
  if (!row) return null;
  return assembleAdminContentDetail(env, tenantId, 'folder', row);
}

async function assembleAdminContentDetail(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  targetType: AdminContentTargetType,
  row: AdminContentDetailRow
): Promise<AdminContentDetail> {
  const breadcrumbFolderId =
    targetType === 'folder' ? row.id : row.folder_id;
  const [breadcrumbMap, permissions, sharedLinks, versions, versionCount, lock, inspectPolicy] =
    await Promise.all([
      breadcrumbFolderId
        ? loadFolderBreadcrumbMap(env.DB, tenantId, [breadcrumbFolderId])
        : Promise.resolve(new Map<string, FolderBreadcrumb[]>()),
      env.DB.prepare(
        `SELECT p.id, p.grantee_type, p.grantee_id,
                COALESCE(gu.display_name, gg.name, p.grantee_id) AS grantee_name,
                gu.email AS grantee_email,
                p.role, p.granted_by,
                actor.email AS granted_by_email, p.created_at
           FROM permissions p
           LEFT JOIN users gu
             ON p.grantee_type = 'user'
            AND gu.tenant_id = p.tenant_id AND gu.id = p.grantee_id
           LEFT JOIN groups gg
             ON p.grantee_type = 'group'
            AND gg.tenant_id = p.tenant_id AND gg.id = p.grantee_id
           LEFT JOIN users actor
             ON actor.tenant_id = p.tenant_id AND actor.id = p.granted_by
          WHERE p.tenant_id = ? AND p.target_type = ? AND p.target_id = ?
          ORDER BY p.created_at ASC, p.id ASC`
      )
        .bind(tenantId, targetType, row.id)
        .all<PermissionRow>(),
      env.DB.prepare(
        `SELECT sl.id, sl.target_type, sl.target_id, sl.access_scope,
                sl.permission_level, sl.can_download, sl.require_watermark,
                sl.password_hash, sl.locked_until, sl.expires_at,
                sl.max_downloads, sl.download_count, sl.created_by,
                creator.email AS creator_email, sl.created_at
           FROM shared_links sl
           LEFT JOIN users creator
             ON creator.tenant_id = sl.tenant_id AND creator.id = sl.created_by
          WHERE sl.tenant_id = ? AND sl.target_type = ? AND sl.target_id = ?
            AND sl.revoked_at IS NULL
          ORDER BY sl.created_at DESC`
      )
        .bind(tenantId, targetType, row.id)
        .all<SharedLinkDetailRow>(),
      targetType === 'file'
        ? env.DB.prepare(
            `SELECT fv.id, fv.version_num, fv.size_bytes, fv.mime_type,
                    fv.upload_status, fv.uploaded_by,
                    uploader.email AS uploaded_by_email, fv.comment,
                    fv.created_at
               FROM file_versions fv
               LEFT JOIN users uploader
                 ON uploader.tenant_id = fv.tenant_id
                AND uploader.id = fv.uploaded_by
              WHERE fv.tenant_id = ? AND fv.file_id = ?
              ORDER BY fv.version_num DESC
              LIMIT 50`
          )
            .bind(tenantId, row.id)
            .all<VersionRow>()
        : Promise.resolve({ results: [] as VersionRow[] }),
      targetType === 'file'
        ? env.DB.prepare(
            `SELECT COUNT(*) AS cnt FROM file_versions
              WHERE tenant_id = ? AND file_id = ?`
          )
            .bind(tenantId, row.id)
            .first<{ cnt: number }>()
        : Promise.resolve(null),
      targetType === 'file'
        ? getFileLockState(env, row.id)
        : Promise.resolve(null),
      getAdminContentInspectPolicy(env.DB, tenantId),
    ]);

  if (targetType === 'file' && lock) {
    await buildActiveFileLockUpsertStmt(env.DB, lock).run();
  } else if (targetType === 'file' && !lock) {
    await buildActiveFileLockDeleteStmt(env.DB, row.id, tenantId).run();
  }

  const breadcrumbs = breadcrumbFolderId
    ? breadcrumbMap.get(breadcrumbFolderId) ?? []
    : [];
  const nowMs = Date.now();

  return {
    targetType,
    id: row.id,
    name: row.name,
    folderId: row.folder_id,
    parentId: row.parent_id,
    pathLabel: folderPathLabel(breadcrumbs),
    breadcrumbs,
    owner: {
      id: row.created_by,
      email: row.owner_email,
      displayName: row.owner_display_name,
    },
    classification: row.classification,
    extension: row.extension,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    currentVersionId: row.current_version_id,
    currentVersionNum: row.current_version_num,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeLock: lock,
    permissions: permissions.results.map((permission) => ({
      id: permission.id,
      granteeType: permission.grantee_type,
      granteeId: permission.grantee_id,
      granteeName: permission.grantee_name,
      granteeEmail: permission.grantee_email,
      role: permission.role,
      grantedBy: permission.granted_by,
      grantedByEmail: permission.granted_by_email,
      createdAt: permission.created_at,
    })),
    sharedLinks: sharedLinks.results.map((link) => ({
      id: link.id,
      targetType: link.target_type,
      targetId: link.target_id,
      accessScope: link.access_scope,
      permissionLevel: resolvePermissionLevel({
        access_scope: link.access_scope as ShareAccessScope,
        can_download: link.can_download,
        permission_level: link.permission_level,
      }),
      canDownload: link.can_download === 1,
      requireWatermark: link.require_watermark === 1,
      hasPassword: Boolean(link.password_hash),
      isLocked: Boolean(
        link.locked_until && Date.parse(link.locked_until) > nowMs
      ),
      expiresAt: link.expires_at,
      maxDownloads: link.max_downloads,
      downloadCount: link.download_count,
      createdBy: link.created_by,
      creatorEmail: link.creator_email,
      createdAt: link.created_at,
    })),
    versions: {
      total: Number(versionCount?.cnt ?? 0),
      items: versions.results.map((version) => ({
        id: version.id,
        versionNum: version.version_num,
        sizeBytes: version.size_bytes,
        mimeType: version.mime_type,
        uploadStatus: version.upload_status,
        uploadedBy: version.uploaded_by,
        uploadedByEmail: version.uploaded_by_email,
        comment: version.comment,
        createdAt: version.created_at,
      })),
    },
    inspectPolicy,
  };
}
