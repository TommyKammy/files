import type { AuthUser, ResourceRole, ShareAccessScope } from '../types/api';
import {
  can,
  orderCapabilities,
  ROLE_CAPABILITIES,
  type Capability,
} from './capabilities';

export type SharePermissionLevel = 'view' | 'download' | 'edit';

export const SHARE_PERMISSION_LEVELS: readonly SharePermissionLevel[] = [
  'view',
  'download',
  'edit',
];

export interface ShareLinkPolicyFlags {
  allow_shared_link_edit: number;
  allow_public_edit_links: number;
  allow_viewer_share_links: number;
  enforce_company_only_links?: number;
  require_watermark_confidential?: number;
  max_link_expiration_days?: number | null;
}

export const DEFAULT_SHARE_LINK_POLICY: ShareLinkPolicyFlags = {
  allow_shared_link_edit: 0,
  allow_public_edit_links: 0,
  allow_viewer_share_links: 0,
  enforce_company_only_links: 0,
  require_watermark_confidential: 1,
  max_link_expiration_days: 30,
};

export interface ShareLinkPermissionRow {
  access_scope: ShareAccessScope;
  can_download: number;
  require_watermark?: number;
  permission_level?: string | null;
}

const VIEW_LINK_CAPABILITIES: readonly Capability[] = [
  'folder.list',
  'folder.traverse',
  'item.preview',
];

const DOWNLOAD_LINK_CAPABILITIES: readonly Capability[] = [
  ...VIEW_LINK_CAPABILITIES,
  'item.download',
];

/**
 * Edit links grant upload/version/WOPI editing only. They deliberately never
 * grant rename, move, delete, permission management, sharing, or classification
 * changes.
 */
const EDIT_LINK_CAPABILITIES: readonly Capability[] = [
  'folder.list',
  'folder.traverse',
  'folder.create',
  'item.preview',
  'item.download',
  'item.upload_new',
  'item.upload_version',
  'item.edit_content',
];

export function isSharePermissionLevel(value: unknown): value is SharePermissionLevel {
  return value === 'view' || value === 'download' || value === 'edit';
}

/** Legacy rows only have `can_download`; fall back to it when no level exists. */
export function resolvePermissionLevel(
  link: ShareLinkPermissionRow
): SharePermissionLevel {
  if (isSharePermissionLevel(link.permission_level)) {
    return link.permission_level;
  }
  return link.can_download === 1 ? 'download' : 'view';
}

/** `view` is the only level with downloads disabled; edit keeps legacy `can_download = 1`. */
export function canDownloadForPermissionLevel(level: SharePermissionLevel): number {
  return level === 'view' ? 0 : 1;
}

export async function getShareLinkPolicyFlags(
  db: D1Database,
  tenantId: string
): Promise<ShareLinkPolicyFlags> {
  const row = await db
    .prepare(
      `SELECT allow_shared_link_edit, allow_public_edit_links, allow_viewer_share_links,
              enforce_company_only_links, require_watermark_confidential,
              max_link_expiration_days
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<Partial<ShareLinkPolicyFlags>>();
  return {
    allow_shared_link_edit: row?.allow_shared_link_edit === 1 ? 1 : 0,
    allow_public_edit_links: row?.allow_public_edit_links === 1 ? 1 : 0,
    allow_viewer_share_links: row?.allow_viewer_share_links === 1 ? 1 : 0,
    enforce_company_only_links: row?.enforce_company_only_links === 1 ? 1 : 0,
    require_watermark_confidential:
      row?.require_watermark_confidential === 0 ? 0 : 1,
    max_link_expiration_days:
      typeof row?.max_link_expiration_days === 'number'
        ? row.max_link_expiration_days
        : 30,
  };
}

function roleFromCapabilities(capabilities: readonly Capability[]): ResourceRole | null {
  const set = new Set(capabilities);
  // Preserve privileged collaborator labels only when the full preset fits.
  for (const role of ['owner', 'co_owner', 'editor'] as const) {
    if ([...ROLE_CAPABILITIES[role]].every((capability) => set.has(capability))) {
      return role;
    }
  }

  const hasPreview = set.has('item.preview');
  const hasDownload = set.has('item.download');
  const hasUploadNew = set.has('item.upload_new');
  const hasEditContent = set.has('item.edit_content');
  if (hasPreview && hasDownload && hasUploadNew && hasEditContent) {
    return 'viewer_uploader';
  }
  if (hasPreview && hasUploadNew) return 'previewer_uploader';
  if (hasPreview && hasDownload) return 'viewer';
  if (hasPreview) return 'previewer';
  if (hasUploadNew) return 'uploader';
  return null;
}

export interface EffectiveShareCapabilities {
  /** Link's declared level (never silently rewritten for the API response). */
  permissionLevel: SharePermissionLevel;
  canDownload: boolean;
  canEdit: boolean;
  requireWatermark: boolean;
  /** True when the link is `edit` but anonymous writes were denied by policy. */
  anonymousEditBlocked: boolean;
  /** True when the caller could gain edit rights by signing in. */
  requiresAuthForEdit: boolean;
  /** True when the tenant policy has switched shared-link editing off. */
  editDisabledByPolicy: boolean;
  composedRole: ResourceRole | null;
  composedCapabilities: Capability[];
}

/**
 * Compose link-level capabilities with the authenticated caller's collaborator
 * capabilities. Anonymous callers receive link capabilities only.
 */
export function resolveEffectiveShareCapabilities(input: {
  link: ShareLinkPermissionRow;
  collaboratorCapabilities?: readonly Capability[] | null;
  user: AuthUser | null;
  policy: ShareLinkPolicyFlags;
  isConfidential?: boolean;
}): EffectiveShareCapabilities {
  const permissionLevel = resolvePermissionLevel(input.link);
  const isConfidential = input.isConfidential === true;
  const isAnonymous = input.user === null;
  const publicEditAllowed =
    input.link.access_scope === 'public' &&
    input.policy.allow_public_edit_links === 1;
  const editEnabledByPolicy = input.policy.allow_shared_link_edit === 1;

  let linkCapabilities: Capability[];
  let anonymousEditBlocked = false;
  let canEdit = false;
  let editDisabledByPolicy = false;

  if (permissionLevel === 'view') {
    linkCapabilities = [...VIEW_LINK_CAPABILITIES];
  } else if (permissionLevel === 'download') {
    linkCapabilities = [...DOWNLOAD_LINK_CAPABILITIES];
  } else if (!editEnabledByPolicy) {
    // Policy can be revoked after a link was created. Keep read access but
    // never advertise or exercise edit rights.
    linkCapabilities = [...DOWNLOAD_LINK_CAPABILITIES];
    editDisabledByPolicy = true;
  } else if (isAnonymous && !publicEditAllowed) {
    linkCapabilities = [...DOWNLOAD_LINK_CAPABILITIES];
    anonymousEditBlocked = true;
  } else {
    linkCapabilities = [...EDIT_LINK_CAPABILITIES];
    canEdit = true;
  }

  const composed = new Set<Capability>(linkCapabilities);
  if (!isAnonymous && input.collaboratorCapabilities) {
    for (const capability of input.collaboratorCapabilities) {
      composed.add(capability);
    }
  }

  if (isConfidential) {
    // Confidential floor: never expose a downloadable object key and always
    // require the DLP watermark.
    composed.delete('item.download');
    canEdit = false;
  }
  if (!editEnabledByPolicy) canEdit = false;
  if (isAnonymous && !publicEditAllowed) canEdit = false;

  const composedCapabilities = orderCapabilities(composed);
  const requiresAuthForEdit =
    permissionLevel === 'edit' && isAnonymous && !publicEditAllowed;

  return {
    permissionLevel,
    canDownload: can(composedCapabilities, 'item.download'),
    canEdit: canEdit && can(composedCapabilities, 'item.edit_content'),
    requireWatermark: isConfidential || input.link.require_watermark === 1,
    anonymousEditBlocked,
    requiresAuthForEdit,
    editDisabledByPolicy,
    composedRole: roleFromCapabilities(composedCapabilities),
    composedCapabilities,
  };
}

/**
 * Project dynamic `share_link.create` onto plain `viewer` role capabilities
 * when the tenant enables viewer-created display-only links.
 */
export function projectViewerShareLinkCapability(
  capabilities: readonly Capability[],
  effectiveRole: ResourceRole | null | undefined,
  allowViewerShareLinks: number | boolean | undefined
): Capability[] {
  const enabled = allowViewerShareLinks === 1 || allowViewerShareLinks === true;
  if (!enabled || effectiveRole !== 'viewer') {
    return [...capabilities];
  }
  if (capabilities.includes('share_link.create')) {
    return [...capabilities];
  }
  return orderCapabilities([...capabilities, 'share_link.create']);
}

export function projectPolicyViewerShareLinkCapability(
  capabilities: readonly Capability[],
  effectiveRole: ResourceRole | null | undefined,
  policy: { allow_viewer_share_links?: number } | null | undefined
): Capability[] {
  return projectViewerShareLinkCapability(
    capabilities,
    effectiveRole,
    policy?.allow_viewer_share_links
  );
}
