import type { ClassificationLabel, ResourceRole } from '../types/api';
import {
  areAdvancedRolesEnabled,
  resolveTargetAccess,
} from './authorization';
import {
  buildGuestInvitationMailPreview,
  guestGrantableRoles,
} from './guest-collaboration';
import {
  emailDomain,
  getGuestPolicy,
  isGuestDomainAllowed,
  type GuestPolicy,
} from './external-guests';

/**
 * Shared guest detail projection used by:
 * - `GET /api/guests/:userId/summary` (internal collaboration view)
 * - `GET /api/admin/guests/:id` (governance console)
 * - the admin guest CSV/JSON export
 *
 * DLP invariant: shared item entries are metadata only. R2 object keys, signed
 * URLs, file bytes, AI reason text and raw invitation/OTP tokens are never
 * selected here, so the same projection is safe for both surfaces.
 */

export interface GuestInvitationRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  email: string;
  display_name: string;
  external_org: string | null;
  invited_by: string;
  target_type: 'folder' | 'file';
  target_id: string;
  role: ResourceRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  resend_count: number;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
  target_name: string | null;
  invited_by_name?: string | null;
}

export function projectGuestInvitation(row: GuestInvitationRow) {
  const nowIso = new Date().toISOString();
  const status =
    row.status === 'pending' && row.expires_at <= nowIso
      ? 'expired'
      : row.status;
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    externalOrg: row.external_org,
    invitedBy: row.invited_by,
    invitedByName: row.invited_by_name ?? null,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    role: row.role,
    status,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    resendCount: row.resend_count,
    lastSentAt: row.last_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mailPreview: buildGuestInvitationMailPreview({
      displayName: row.display_name,
      externalOrg: row.external_org,
      targetType: row.target_type,
      targetName: row.target_name,
      role: row.role,
      expiresAt: row.expires_at,
      invitedByName: row.invited_by_name ?? null,
    }),
  };
}

export async function loadGuestInvitation(
  db: D1Database,
  tenantId: string,
  id: string
): Promise<GuestInvitationRow | null> {
  return db
    .prepare(
      `SELECT gi.*,
              COALESCE(f.name, fl.name) AS target_name,
              inviter.display_name AS invited_by_name
         FROM guest_invitations gi
         LEFT JOIN folders f
           ON gi.target_type = 'folder' AND f.tenant_id = gi.tenant_id AND f.id = gi.target_id
         LEFT JOIN files fl
           ON gi.target_type = 'file' AND fl.tenant_id = gi.tenant_id AND fl.id = gi.target_id
         LEFT JOIN users inviter ON inviter.id = gi.invited_by
        WHERE gi.tenant_id = ? AND gi.id = ?`
    )
    .bind(tenantId, id)
    .first<GuestInvitationRow>();
}

export interface GuestPermissionRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  role: ResourceRole;
  created_at: string;
  target_name: string | null;
  classification: ClassificationLabel;
  parent_id: string | null;
  folder_id: string | null;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  updated_at: string | null;
}

export interface GuestGrantSourceRow {
  permission_id: string;
  role: ResourceRole;
  source_type: 'folder' | 'file';
  source_id: string;
  source_name: string | null;
}

export interface GuestEffectivePermission {
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string | null;
  role: ResourceRole;
  inherited: boolean;
  inheritedFromName: string | null;
  synthesizedRole: ResourceRole | null;
  capabilities: string[];
}

export interface GuestSharedItem {
  itemType: 'folder' | 'file';
  id: string;
  name: string;
  classification: ClassificationLabel;
  /** Metadata-only DLP marker; confidential content is never exported. */
  dlpProtected: boolean;
  pathLabel: string;
  effectiveRole: ResourceRole | null;
  synthesizedRole: ResourceRole | null;
  capabilities: string[];
  folderId: string | null;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
}

export type GuestLifecycleStatus =
  | 'active'
  | 'suspended'
  | 'expired'
  | 'pending_invite'
  | 'offboarded';

export interface GuestDetail {
  guest: {
    id: string;
    email: string;
    displayName: string;
    userType: 'guest';
    externalOrg: string | null;
    /** Raw `users.status` (active/suspended). */
    accountStatus: 'active' | 'suspended';
    /** Lifecycle projection used by the admin list/detail. */
    status: GuestLifecycleStatus;
    expiresAt: string | null;
    lastLoginAt: string | null;
    invitedBy: string | null;
    invitedByName: string | null;
    invitedByEmail: string | null;
    offboardedAt: string | null;
    offboardedBy: string | null;
    domain: string | null;
    domainAllowedByPolicy: boolean;
    createdAt: string;
  };
  invitations: ReturnType<typeof projectGuestInvitation>[];
  effectivePermissions: GuestEffectivePermission[];
  sharedItems: GuestSharedItem[];
  guestPolicy: {
    allowExternalCollaborators: boolean;
    externalDomainAllowlist: string[];
    allowGuestElevatedRoles: boolean;
    guestGrantableRoles: ResourceRole[];
    guestInvitationExpiryDays: number;
    externalDomainExistingGuestMode: GuestPolicy['externalDomainExistingGuestMode'];
  };
  accessSummary: {
    folderCount: number;
    fileCount: number;
    itemCount: number;
    invitationCount: number;
  };
  pendingInvitationId: string | null;
}

interface GuestDetailUserRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'suspended';
  external_org: string | null;
  expires_at: string | null;
  last_login_at: string | null;
  invited_by: string | null;
  invited_by_name: string | null;
  invited_by_email: string | null;
  offboarded_at: string | null;
  offboarded_by: string | null;
  created_at: string;
}

export function computeGuestLifecycleStatus(input: {
  accountStatus: 'active' | 'suspended';
  offboardedAt: string | null;
  expiresAt: string | null;
  lastLoginAt: string | null;
  pendingInvitationCount: number;
  nowIso?: string;
}): GuestLifecycleStatus {
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (input.offboardedAt) return 'offboarded';
  if (input.accountStatus !== 'active') return 'suspended';
  if (input.expiresAt && input.expiresAt <= nowIso) return 'expired';
  if (input.lastLoginAt === null && input.pendingInvitationCount > 0) {
    return 'pending_invite';
  }
  return 'active';
}

export async function loadGuestPermissionRows(
  db: D1Database,
  tenantId: string,
  guestId: string
): Promise<GuestPermissionRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id,
              p.target_type,
              p.target_id,
              p.role,
              p.created_at,
              COALESCE(f.name, fl.name) AS target_name,
              COALESCE(f.classification, fl.classification) AS classification,
              f.parent_id,
              fl.folder_id,
              fl.extension,
              fl.mime_type,
              fl.size_bytes,
              COALESCE(f.updated_at, fl.updated_at) AS updated_at
         FROM permissions p
         LEFT JOIN folders f
           ON p.target_type = 'folder'
          AND f.tenant_id = p.tenant_id
          AND f.id = p.target_id
          AND f.deleted_at IS NULL
         LEFT JOIN files fl
           ON p.target_type = 'file'
          AND fl.tenant_id = p.tenant_id
          AND fl.id = p.target_id
          AND fl.deleted_at IS NULL
        WHERE p.tenant_id = ?
          AND p.grantee_type = 'user'
          AND p.grantee_id = ?
          AND (f.id IS NOT NULL OR fl.id IS NOT NULL)
        ORDER BY p.created_at ASC`
    )
    .bind(tenantId, guestId)
    .all<GuestPermissionRow>();
  return rows.results.filter(
    (row) => row.target_name !== null && row.classification !== null
  );
}

async function loadGuestGrantSources(
  db: D1Database,
  tenantId: string,
  guestId: string,
  row: GuestPermissionRow
): Promise<GuestGrantSourceRow[]> {
  if (row.target_type === 'folder') {
    const result = await db
      .prepare(
        `SELECT p.id AS permission_id,
                p.role,
                'folder' AS source_type,
                p.target_id AS source_id,
                source_folder.name AS source_name
           FROM folder_closures fc
           JOIN permissions p
             ON p.tenant_id = fc.tenant_id
            AND p.target_type = 'folder'
            AND p.target_id = fc.ancestor_id
           LEFT JOIN folders source_folder ON source_folder.id = p.target_id
          WHERE fc.tenant_id = ?
            AND fc.descendant_id = ?
            AND p.grantee_type = 'user'
            AND p.grantee_id = ?
          ORDER BY fc.depth DESC`
      )
      .bind(tenantId, row.target_id, guestId)
      .all<GuestGrantSourceRow>();
    return result.results;
  }

  const [direct, inherited] = await Promise.all([
    db
      .prepare(
        `SELECT p.id AS permission_id,
                p.role,
                'file' AS source_type,
                p.target_id AS source_id,
                target_file.name AS source_name
           FROM permissions p
           LEFT JOIN files target_file ON target_file.id = p.target_id
          WHERE p.tenant_id = ?
            AND p.target_type = 'file'
            AND p.target_id = ?
            AND p.grantee_type = 'user'
            AND p.grantee_id = ?`
      )
      .bind(tenantId, row.target_id, guestId)
      .all<GuestGrantSourceRow>(),
    row.folder_id
      ? db
          .prepare(
            `SELECT p.id AS permission_id,
                    p.role,
                    'folder' AS source_type,
                    p.target_id AS source_id,
                    source_folder.name AS source_name
               FROM folder_closures fc
               JOIN permissions p
                 ON p.tenant_id = fc.tenant_id
                AND p.target_type = 'folder'
                AND p.target_id = fc.ancestor_id
               LEFT JOIN folders source_folder ON source_folder.id = p.target_id
              WHERE fc.tenant_id = ?
                AND fc.descendant_id = ?
                AND p.grantee_type = 'user'
                AND p.grantee_id = ?
              ORDER BY fc.depth DESC`
          )
          .bind(tenantId, row.folder_id, guestId)
          .all<GuestGrantSourceRow>()
      : Promise.resolve({ results: [] as GuestGrantSourceRow[] }),
  ]);

  return [...inherited.results, ...direct.results];
}

async function loadPathLabel(
  db: D1Database,
  tenantId: string,
  row: Pick<GuestPermissionRow, 'target_type' | 'target_id' | 'folder_id'>
): Promise<string> {
  const breadcrumbFolderId =
    row.target_type === 'folder' ? row.target_id : row.folder_id;
  if (!breadcrumbFolderId) return 'マイファイル (ルート)';
  const ancestors = await db
    .prepare(
      `SELECT folder.name
         FROM folder_closures fc
         JOIN folders folder
           ON folder.tenant_id = fc.tenant_id
          AND folder.id = fc.ancestor_id
         WHERE fc.tenant_id = ? AND fc.descendant_id = ?
         ORDER BY fc.depth DESC`
    )
    .bind(tenantId, breadcrumbFolderId)
    .all<{ name: string }>();
  return ['マイファイル', ...ancestors.results.map((item) => item.name)].join(
    ' / '
  );
}

/**
 * Load the shared guest detail. Returns `null` when the id is not a guest in
 * the caller's tenant; callers must map that to `404 GUEST_NOT_FOUND` so a
 * cross-tenant probe cannot distinguish "exists elsewhere" from "missing".
 */
export async function loadGuestDetail(
  db: D1Database,
  tenantId: string,
  guestId: string,
  options: { nowIso?: string } = {}
): Promise<GuestDetail | null> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const guest = await db
    .prepare(
      `SELECT u.id,
              u.email,
              u.display_name,
              u.status,
              u.external_org,
              u.expires_at,
              u.last_login_at,
              u.invited_by,
              u.offboarded_at,
              u.offboarded_by,
              u.created_at,
              inviter.display_name AS invited_by_name,
              inviter.email AS invited_by_email
         FROM users u
         LEFT JOIN users inviter ON inviter.id = u.invited_by
        WHERE u.tenant_id = ? AND u.id = ? AND u.user_type = 'guest'`
    )
    .bind(tenantId, guestId)
    .first<GuestDetailUserRow>();
  if (!guest) return null;

  const [invitationRows, permissionRows, guestPolicy, advancedRolesEnabled] =
    await Promise.all([
      db
        .prepare(
          `SELECT gi.*,
                  COALESCE(f.name, fl.name) AS target_name,
                  inviter.display_name AS invited_by_name
             FROM guest_invitations gi
             LEFT JOIN folders f
               ON gi.target_type = 'folder'
              AND f.tenant_id = gi.tenant_id
              AND f.id = gi.target_id
             LEFT JOIN files fl
               ON gi.target_type = 'file'
              AND fl.tenant_id = gi.tenant_id
              AND fl.id = gi.target_id
             LEFT JOIN users inviter ON inviter.id = gi.invited_by
            WHERE gi.tenant_id = ? AND gi.user_id = ?
            ORDER BY gi.created_at DESC
            LIMIT 100`
        )
        .bind(tenantId, guestId)
        .all<GuestInvitationRow>(),
      loadGuestPermissionRows(db, tenantId, guestId),
      getGuestPolicy(db, tenantId),
      areAdvancedRolesEnabled(db, tenantId),
    ]);

  const invitations = invitationRows.results.map(projectGuestInvitation);
  const pendingInvitation = invitations.find(
    (invitation) => invitation.status === 'pending'
  );
  const lifecycleStatus = computeGuestLifecycleStatus({
    accountStatus: guest.status,
    offboardedAt: guest.offboarded_at,
    expiresAt: guest.expires_at,
    lastLoginAt: guest.last_login_at,
    pendingInvitationCount: invitations.filter(
      (invitation) => invitation.status === 'pending'
    ).length,
    nowIso,
  });

  const guestForAccess = { id: guest.id, tenantId };

  const effectivePermissions: GuestEffectivePermission[] = [];
  const seenPermissionKeys = new Set<string>();
  for (const permission of permissionRows) {
    const access = await resolveTargetAccess(
      db,
      guestForAccess,
      permission.target_type,
      permission.target_id
    );
    if (!access || access.accessMode === null) continue;
    const sources = await loadGuestGrantSources(
      db,
      tenantId,
      guestId,
      permission
    );
    for (const source of sources) {
      const inherited =
        source.source_type !== permission.target_type ||
        source.source_id !== permission.target_id;
      const key = [
        permission.target_type,
        permission.target_id,
        source.permission_id,
      ].join(':');
      if (seenPermissionKeys.has(key)) continue;
      seenPermissionKeys.add(key);
      effectivePermissions.push({
        targetType: permission.target_type,
        targetId: permission.target_id,
        targetName: permission.target_name,
        role: source.role,
        inherited,
        inheritedFromName: inherited ? source.source_name : null,
        synthesizedRole: access.effectiveRole,
        capabilities: access.capabilities,
      });
    }
  }

  const sharedItems: GuestSharedItem[] = [];
  for (const permission of permissionRows) {
    const access = await resolveTargetAccess(
      db,
      guestForAccess,
      permission.target_type,
      permission.target_id
    );
    if (!access || access.accessMode === null) continue;
    sharedItems.push({
      itemType: permission.target_type,
      id: permission.target_id,
      name: permission.target_name ?? permission.target_id,
      classification: permission.classification,
      dlpProtected: permission.classification === 'confidential',
      pathLabel: await loadPathLabel(db, tenantId, permission),
      effectiveRole: access.effectiveRole,
      synthesizedRole: access.effectiveRole,
      capabilities: access.capabilities,
      folderId: permission.target_type === 'file' ? permission.folder_id : null,
      extension: permission.target_type === 'file' ? permission.extension : null,
      mimeType: permission.target_type === 'file' ? permission.mime_type : null,
      sizeBytes: permission.target_type === 'file' ? permission.size_bytes : null,
      updatedAt: permission.updated_at,
    });
  }

  return {
    guest: {
      id: guest.id,
      email: guest.email,
      displayName: guest.display_name,
      userType: 'guest',
      externalOrg: guest.external_org,
      accountStatus: guest.status,
      status: lifecycleStatus,
      expiresAt: guest.expires_at,
      lastLoginAt: guest.last_login_at,
      invitedBy: guest.invited_by,
      invitedByName: guest.invited_by_name,
      invitedByEmail: guest.invited_by_email,
      offboardedAt: guest.offboarded_at,
      offboardedBy: guest.offboarded_by,
      domain: emailDomain(guest.email),
      domainAllowedByPolicy: isGuestDomainAllowed(
        emailDomain(guest.email),
        guestPolicy.externalDomainAllowlist
      ),
      createdAt: guest.created_at,
    },
    invitations,
    effectivePermissions,
    sharedItems,
    guestPolicy: {
      allowExternalCollaborators: guestPolicy.allowExternalCollaborators,
      externalDomainAllowlist: guestPolicy.externalDomainAllowlist,
      allowGuestElevatedRoles: guestPolicy.allowGuestElevatedRoles,
      guestGrantableRoles: [
        ...new Set([
          ...guestGrantableRoles(guestPolicy, {
            advancedRolesEnabled,
            targetType: 'folder',
          }),
          ...guestGrantableRoles(guestPolicy, {
            advancedRolesEnabled,
            targetType: 'file',
          }),
        ]),
      ],
      guestInvitationExpiryDays: guestPolicy.guestInvitationExpiryDays,
      externalDomainExistingGuestMode:
        guestPolicy.externalDomainExistingGuestMode,
    },
    accessSummary: {
      folderCount: sharedItems.filter((item) => item.itemType === 'folder')
        .length,
      fileCount: sharedItems.filter((item) => item.itemType === 'file').length,
      itemCount: sharedItems.length,
      invitationCount: invitations.length,
    },
    pendingInvitationId: pendingInvitation?.id ?? null,
  };
}

export async function listTenantGuestInvitations(
  db: D1Database,
  tenantId: string,
  target?: { targetType: 'folder' | 'file'; targetId: string }
) {
  const filters = ['gi.tenant_id = ?'];
  const bindings: unknown[] = [tenantId];
  if (target) {
    filters.push('gi.target_type = ?', 'gi.target_id = ?');
    bindings.push(target.targetType, target.targetId);
  }

  const rows = await db
    .prepare(
      `SELECT gi.*,
              COALESCE(f.name, fl.name) AS target_name,
              inviter.display_name AS invited_by_name
         FROM guest_invitations gi
         LEFT JOIN folders f
           ON gi.target_type = 'folder' AND f.tenant_id = gi.tenant_id AND f.id = gi.target_id
         LEFT JOIN files fl
           ON gi.target_type = 'file' AND fl.tenant_id = gi.tenant_id AND fl.id = gi.target_id
         LEFT JOIN users inviter ON inviter.id = gi.invited_by
        WHERE ${filters.join(' AND ')}
        ORDER BY gi.created_at DESC
        LIMIT 100`
    )
    .bind(...bindings)
    .all<GuestInvitationRow>();

  return { invitations: rows.results.map(projectGuestInvitation) };
}
