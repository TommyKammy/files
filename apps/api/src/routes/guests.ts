import { Hono, type Context } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  areAdvancedRolesEnabled,
  getAuthenticatedUser,
  requireMemberUser,
  resolveTargetAccess,
} from '../services/authorization';
import { can, isResourceRole } from '../services/capabilities';
import { generateRandomToken, sha256Hex } from '../services/crypto-utils';
import {
  getGuestPolicy,
  guestRoleRestriction,
  isGuestEmailDomainAllowed,
  type GuestPolicy,
} from '../services/external-guests';
import {
  buildGuestInvitationMailPreview,
  guestGrantableRoles,
} from '../services/guest-collaboration';
import {
  computeEffectivePermissionsCapabilities,
  isRoleWithinCapabilitySubset,
  resolveEffectiveInvitePolicy,
} from '../services/invite-policy';
import {
  MailDeliveryError,
  MailProviderConfigurationError,
  resolveMailProvider,
} from '../services/mail-provider';
import type { AuthUser, ResourceRole } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { getCallbackBaseOrigin } from './auth/shared';

const VALID_TARGET_TYPES = new Set(['folder', 'file']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface GuestInvitationRow {
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

interface GuestUserRow {
  id: string;
  email: string;
  display_name: string;
  user_type: 'member' | 'guest';
  status: 'active' | 'suspended';
  expires_at: string | null;
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 254 || !EMAIL_RE.test(value)) return null;
  return value;
}

function projectInvitation(row: GuestInvitationRow) {
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

async function loadInvitation(
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

interface AuthorizationResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404;
  code?: string;
  error?: string;
  policy?: GuestPolicy;
  canGrantRole?: boolean;
}

/**
 * Admin (sys_admin) bypasses target ACL checks, but a normal member must both
 * pass the TOM-58 effective invite policy and stay within their own capability
 * subset. Guests never reach this function (requireMemberUser).
 */
async function authorizeInvitationTarget(
  db: D1Database,
  user: AuthUser,
  targetType: 'folder' | 'file',
  targetId: string,
  requestedRole?: ResourceRole
): Promise<AuthorizationResult> {
  const policy = await getGuestPolicy(db, user.tenantId);

  const access = await resolveTargetAccess(db, user, targetType, targetId);
  if (!access || access.deletedAt !== null) {
    return { ok: false, status: 404, error: 'Target resource not found' };
  }

  if (!policy.allowExternalCollaborators) {
    return {
      ok: false,
      status: 403,
      code: 'EXTERNAL_COLLABORATORS_DISABLED',
      error: 'External collaborators are disabled for this tenant',
    };
  }

  if (user.role === 'sys_admin') {
    return { ok: true, status: 200, policy, canGrantRole: true };
  }

  const policyFolderId = targetType === 'folder' ? targetId : access.folderId;
  const resolvedInvitePolicy = await resolveEffectiveInvitePolicy(
    db,
    user.tenantId,
    policyFolderId
  );
  const effectiveCapabilities = computeEffectivePermissionsCapabilities(
    access.capabilities,
    access.effectiveRole,
    resolvedInvitePolicy.effectivePolicy,
    user.role
  );
  const canInvite = effectiveCapabilities.includes('permission.invite');
  if (!canInvite) {
    return {
      ok: false,
      status: 403,
      code: 'INVITE_POLICY_RESTRICTED',
      error: `Invitations are restricted by the effective invite policy (${resolvedInvitePolicy.effectivePolicy})`,
    };
  }
  if (
    requestedRole &&
    !isRoleWithinCapabilitySubset(requestedRole, effectiveCapabilities)
  ) {
    return {
      ok: false,
      status: 403,
      code: 'ROLE_EXCEEDS_CALLER_CAPABILITIES',
      error: 'Requested role exceeds your capabilities',
    };
  }

  return { ok: true, status: 200, policy, canGrantRole: true };
}

async function sendInvitationMail(
  c: Context<OidcHonoEnv>,
  tenantId: string,
  invitation: {
    id: string;
    email: string;
    display_name: string;
    external_org: string | null;
    target_type: 'folder' | 'file';
    target_name: string | null;
    expires_at: string;
  },
  rawToken: string,
  tokenHash: string
): Promise<void> {
  const acceptUrl = `${getCallbackBaseOrigin(c.env, c.req.url)}/guest/accept?token=${encodeURIComponent(rawToken)}`;
  const provider = resolveMailProvider(c.env);
  const targetName = invitation.target_name ?? invitation.target_type;
  const expiry = new Date(invitation.expires_at).toISOString();
  await provider.send({
    tenantId,
    kind: 'guest_invitation',
    to: invitation.email,
    subject: '【Files】外部ゲストコラボレーターの招待',
    text: [
      `${invitation.display_name} 様`,
      '',
      'Files のワークスペースへ外部ゲストコラボレーターとして招待されました。',
      `共有対象: ${targetName}`,
      invitation.external_org ? `外部組織: ${invitation.external_org}` : null,
      `招待の有効期限: ${expiry}`,
      '',
      '以下の URL から招待を承諾し、メールに届く 6 桁の認証コードでサインインしてください。',
      acceptUrl,
      '',
      'このメールに心当たりがない場合は破棄してください。',
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
    token: rawToken,
    acceptUrl,
  });

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE guest_invitations
        SET token_hash = ?, last_sent_at = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?`
  )
    .bind(tokenHash, nowIso, nowIso, tenantId, invitation.id)
    .run();
}

function mailErrorResponse(c: Context<OidcHonoEnv>, err: unknown): Response {
  if (err instanceof MailProviderConfigurationError) {
    return c.json(
      {
        error: 'Mail provider is not configured for guest invitations',
        code: 'MAIL_PROVIDER_NOT_CONFIGURED',
      },
      503
    );
  }
  if (err instanceof MailDeliveryError) {
    return c.json(
      { error: 'Failed to deliver the guest email', code: 'MAIL_DELIVERY_FAILED' },
      502
    );
  }
  throw err;
}

export const guestsRoutes = new Hono<OidcHonoEnv>();
guestsRoutes.use('*', sessionAuthMiddleware({ required: true }), requireMemberUser);

/** GET /api/guests/invitations — tenant guest invitation list. */
guestsRoutes.get('/invitations', async (c) => {
  const user = getAuthenticatedUser(c);
  const targetType = c.req.query('targetType');
  const targetId = c.req.query('targetId');

  if (targetType && !VALID_TARGET_TYPES.has(targetType)) {
    return c.json({ error: 'targetType must be folder or file' }, 400);
  }
  if ((targetType && !targetId) || (!targetType && targetId)) {
    return c.json({ error: 'targetType and targetId must be provided together' }, 400);
  }

  if (user.role !== 'sys_admin') {
    if (!targetType || !targetId) {
      return c.json(
        {
          error: 'Only sys_admin can list every guest invitation in the tenant',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }
    const auth = await authorizeInvitationTarget(
      c.env.DB,
      user,
      targetType as 'folder' | 'file',
      targetId
    );
    if (!auth.ok) {
      return c.json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    }
  } else if (targetType && targetId) {
    // sys_admin bypasses ACL checks but never cross-tenant target probing.
    const target = await c.env.DB.prepare(
      targetType === 'folder'
        ? 'SELECT id FROM folders WHERE tenant_id = ? AND id = ?'
        : 'SELECT id FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, targetId)
      .first<{ id: string }>();
    if (!target) {
      return c.json({ error: 'Target resource not found' }, 404);
    }
  }

  const filters = [`gi.tenant_id = ?`];
  const bindings: unknown[] = [user.tenantId];
  if (targetType && targetId) {
    filters.push('gi.target_type = ?', 'gi.target_id = ?');
    bindings.push(targetType, targetId);
  }

  const rows = await c.env.DB.prepare(
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

  return c.json({ invitations: rows.results.map(projectInvitation) });
});

/** POST /api/guests/invitations — create a guest account + single-use invitation. */
guestsRoutes.post('/invitations', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    email?: unknown;
    displayName?: unknown;
    externalOrg?: unknown;
    targetType?: unknown;
    targetId?: unknown;
    role?: unknown;
  } | null;

  if (!body) return c.json({ error: 'JSON body required' }, 400);

  const email = normalizeEmail(body.email);
  if (!email) {
    return c.json(
      { error: 'email must be a valid email address', code: 'INVALID_EMAIL' },
      400
    );
  }
  const displayName =
    typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim().slice(0, 120)
      : email.split('@')[0];
  const externalOrg =
    typeof body.externalOrg === 'string' && body.externalOrg.trim()
      ? body.externalOrg.trim().slice(0, 120)
      : null;
  if (
    typeof body.targetType !== 'string' ||
    !VALID_TARGET_TYPES.has(body.targetType) ||
    typeof body.targetId !== 'string' ||
    !body.targetId.trim()
  ) {
    return c.json({ error: 'targetType and targetId are required' }, 400);
  }
  if (typeof body.role !== 'string' || !isResourceRole(body.role)) {
    return c.json({ error: 'Invalid role' }, 400);
  }

  const targetType = body.targetType as 'folder' | 'file';
  const targetId = body.targetId.trim();
  const role = body.role as ResourceRole;

  const auth = await authorizeInvitationTarget(
    c.env.DB,
    user,
    targetType,
    targetId,
    role
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
  }
  const policy = auth.policy!;

  // Domain allowlist is fail-closed: an empty list rejects every domain.
  if (!isGuestEmailDomainAllowed(email, policy.externalDomainAllowlist)) {
    return c.json(
      {
        error: 'This external email domain is not on the guest domain allowlist',
        code: 'EXTERNAL_DOMAIN_NOT_ALLOWED',
      },
      403
    );
  }

  const roleError = guestRoleRestriction(role, {
    allowGuestElevatedRoles: policy.allowGuestElevatedRoles,
    advancedRolesEnabled: await areAdvancedRolesEnabled(c.env.DB, user.tenantId),
    targetType,
  });
  if (roleError) {
    return c.json({ error: roleError.message, code: roleError.code }, roleError.status);
  }

  const existingUser = await c.env.DB.prepare(
    `SELECT id, email, display_name, user_type, status, expires_at
       FROM users WHERE tenant_id = ? AND email = ?`
  )
    .bind(user.tenantId, email)
    .first<GuestUserRow>();

  if (existingUser && existingUser.user_type !== 'guest') {
    return c.json(
      {
        error: 'An internal member already uses this email address',
        code: 'EMAIL_ALREADY_MEMBER',
      },
      409
    );
  }

  const target = await c.env.DB.prepare(
    targetType === 'folder'
      ? 'SELECT name FROM folders WHERE tenant_id = ? AND id = ?'
      : 'SELECT name FROM files WHERE tenant_id = ? AND id = ?'
  )
    .bind(user.tenantId, targetId)
    .first<{ name: string }>();
  if (!target) {
    return c.json({ error: 'Target resource not found' }, 404);
  }

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + policy.guestInvitationExpiryDays * 24 * 3600 * 1000
  ).toISOString();
  const rawToken = generateRandomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const invitationId = crypto.randomUUID();
  const guestUserId = existingUser?.id ?? crypto.randomUUID();

  const statements: D1PreparedStatement[] = [];
  if (existingUser) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE users
            SET display_name = ?, external_org = ?, invited_by = ?,
                expires_at = ?, status = 'active', updated_at = ?
          WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
      ).bind(
        displayName,
        externalOrg,
        user.id,
        expiresAt,
        nowIso,
        user.tenantId,
        guestUserId
      ),
      // A new invitation supersedes any previous pending token for this guest.
      c.env.DB.prepare(
        `UPDATE guest_invitations
            SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
          WHERE tenant_id = ? AND user_id = ? AND status = 'pending'`
      ).bind(nowIso, user.id, nowIso, user.tenantId, guestUserId)
    );
  } else {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO users (
           id, tenant_id, email, display_name, role, status, user_type,
           external_org, invited_by, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'member', 'active', 'guest', ?, ?, ?, ?, ?)`
      ).bind(
        guestUserId,
        user.tenantId,
        email,
        displayName,
        externalOrg,
        user.id,
        expiresAt,
        nowIso,
        nowIso
      )
    );
  }

  statements.push(
    c.env.DB.prepare(
      `INSERT INTO guest_invitations (
         id, tenant_id, user_id, email, display_name, external_org, invited_by,
         token_hash, target_type, target_id, role, status, expires_at,
         resend_count, last_sent_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)`
    ).bind(
      invitationId,
      user.tenantId,
      guestUserId,
      email,
      displayName,
      externalOrg,
      user.id,
      tokenHash,
      targetType,
      targetId,
      role,
      expiresAt,
      nowIso,
      nowIso,
      nowIso
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'guest.invite',
      targetType: 'guest_invitation',
      targetId: invitationId,
      metadata: {
        email,
        externalOrg,
        guestUserId,
        targetType,
        targetId,
        role,
        expiresAt,
      },
      nowIso,
    })
  );

  await c.env.DB.batch(statements);

  try {
    await sendInvitationMail(
      c,
      user.tenantId,
      {
        id: invitationId,
        email,
        display_name: displayName,
        external_org: externalOrg,
        target_type: targetType,
        target_name: target.name,
        expires_at: expiresAt,
      },
      rawToken,
      tokenHash
    );
  } catch (err) {
    return mailErrorResponse(c, err);
  }

  const created = await loadInvitation(c.env.DB, user.tenantId, invitationId);
  return c.json(
    {
      invitation: created ? projectInvitation(created) : null,
      notice: `外部ゲスト「${displayName}」へ招待メールを送信しました。有効期限は ${expiresAt} です。`,
    },
    201
  );
});

/** POST /api/guests/invitations/:id/resend — rotate the token and resend. */
guestsRoutes.post('/invitations/:id/resend', async (c) => {
  const user = getAuthenticatedUser(c);
  const invitation = await loadInvitation(c.env.DB, user.tenantId, c.req.param('id'));
  if (!invitation) {
    return c.json({ error: 'Guest invitation not found', code: 'INVITATION_NOT_FOUND' }, 404);
  }

  const auth = await authorizeInvitationTarget(
    c.env.DB,
    user,
    invitation.target_type,
    invitation.target_id
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
  }

  if (invitation.status !== 'pending') {
    return c.json(
      {
        error: `Guest invitation is ${invitation.status} and cannot be resent`,
        code: invitation.status === 'expired' ? 'INVITATION_EXPIRED' : 'INVITATION_NOT_PENDING',
      },
      invitation.status === 'expired' ? 410 : 409
    );
  }
  if (invitation.expires_at <= new Date().toISOString()) {
    await c.env.DB.prepare(
      `UPDATE guest_invitations SET status = 'expired', updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(new Date().toISOString(), user.tenantId, invitation.id)
      .run();
    return c.json({ error: 'Guest invitation has expired', code: 'INVITATION_EXPIRED' }, 410);
  }

  const guest = invitation.user_id
    ? await c.env.DB.prepare(
        `SELECT status, expires_at FROM users
          WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
      )
        .bind(user.tenantId, invitation.user_id)
        .first<{ status: string; expires_at: string | null }>()
    : null;
  if (
    !guest ||
    guest.status !== 'active' ||
    (guest.expires_at && guest.expires_at <= new Date().toISOString())
  ) {
    return c.json(
      { error: 'Guest account is no longer active', code: 'GUEST_ACCOUNT_INACTIVE' },
      403
    );
  }
  if (!isGuestEmailDomainAllowed(invitation.email, auth.policy!.externalDomainAllowlist)) {
    return c.json(
      {
        error: 'This external email domain is not on the guest domain allowlist',
        code: 'EXTERNAL_DOMAIN_NOT_ALLOWED',
      },
      403
    );
  }

  const rawToken = generateRandomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const nowIso = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE guest_invitations
          SET token_hash = ?, resend_count = resend_count + 1, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'pending'`
    ).bind(tokenHash, nowIso, user.tenantId, invitation.id),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'guest.resend',
      targetType: 'guest_invitation',
      targetId: invitation.id,
      metadata: {
        email: invitation.email,
        resend: true,
        resendCount: invitation.resend_count + 1,
        externalOrg: invitation.external_org,
      },
      nowIso,
    }),
  ]);

  try {
    await sendInvitationMail(
      c,
      user.tenantId,
      {
        id: invitation.id,
        email: invitation.email,
        display_name: invitation.display_name,
        external_org: invitation.external_org,
        target_type: invitation.target_type,
        target_name: invitation.target_name,
        expires_at: invitation.expires_at,
      },
      rawToken,
      tokenHash
    );
  } catch (err) {
    return mailErrorResponse(c, err);
  }

  const updated = await loadInvitation(c.env.DB, user.tenantId, invitation.id);
  return c.json({
    invitation: updated ? projectInvitation(updated) : null,
    notice: `招待メールを再送しました（再送回数 ${
      updated?.resend_count ?? invitation.resend_count + 1
    } 回）。`,
  });
});

/** POST /api/guests/invitations/:id/revoke — revoke access and live sessions. */
guestsRoutes.post('/invitations/:id/revoke', async (c) => {
  const user = getAuthenticatedUser(c);
  const invitation = await loadInvitation(c.env.DB, user.tenantId, c.req.param('id'));
  if (!invitation) {
    return c.json({ error: 'Guest invitation not found', code: 'INVITATION_NOT_FOUND' }, 404);
  }

  const auth = await authorizeInvitationTarget(
    c.env.DB,
    user,
    invitation.target_type,
    invitation.target_id
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
  }

  if (invitation.status === 'revoked') {
    return c.json({ ok: true, invitation: projectInvitation(invitation) });
  }

  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE guest_invitations
          SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    ).bind(nowIso, user.id, nowIso, user.tenantId, invitation.id),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'guest.revoke',
      targetType: 'guest_invitation',
      targetId: invitation.id,
      metadata: {
        email: invitation.email,
        guestUserId: invitation.user_id,
        targetType: invitation.target_type,
        targetId: invitation.target_id,
        role: invitation.role,
        previousStatus: invitation.status,
      },
      nowIso,
    }),
  ];

    if (invitation.user_id) {
    statements.push(
      c.env.DB.prepare(
        `DELETE FROM permissions
          WHERE tenant_id = ? AND target_type = ? AND target_id = ?
            AND grantee_type = 'user' AND grantee_id = ?`
      ).bind(
        user.tenantId,
        invitation.target_type,
        invitation.target_id,
        invitation.user_id
      ),
      c.env.DB.prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
      ).bind(nowIso, user.tenantId, invitation.user_id),
      c.env.DB.prepare(
        `UPDATE users SET status = 'suspended', updated_at = ?
          WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
      ).bind(nowIso, user.tenantId, invitation.user_id)
    );
  }

  await c.env.DB.batch(statements);
  const updated = await loadInvitation(c.env.DB, user.tenantId, invitation.id);
  return c.json({
    ok: true,
    invitation: updated ? projectInvitation(updated) : null,
    notice: '招待を取り消し、ゲストの有効セッションを失効させました。',
  });
});

/* ------------------------------------------------------------------------- */
/* P10-2 / TOM-60 guest detail summary                                        */
/* ------------------------------------------------------------------------- */

interface GuestSummaryUserRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'suspended';
  external_org: string | null;
  expires_at: string | null;
  last_login_at: string | null;
  invited_by: string | null;
  invited_by_name: string | null;
}

interface GuestPermissionRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  role: ResourceRole;
  created_at: string;
  target_name: string | null;
  classification: 'unset' | 'confidential' | 'internal' | 'public';
  parent_id: string | null;
  folder_id: string | null;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  updated_at: string | null;
}

interface GuestGrantSourceRow {
  permission_id: string;
  role: ResourceRole;
  source_type: 'folder' | 'file';
  source_id: string;
  source_name: string | null;
}

async function loadGuestPermissionRows(
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
    (row) =>
      row.target_name !== null && row.classification !== null
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
 * GET /api/guests/:userId/summary — internal collaborator view of one guest.
 *
 * Visibility is intentionally narrow: tenant admins, the original inviter, or
 * a member holding `permission.view` on at least one resource shared with the
 * guest. The response is metadata-only: file bytes, R2 keys and raw invitation
 * tokens are never selected or projected.
 */
guestsRoutes.get('/:userId/summary', async (c) => {
  const caller = getAuthenticatedUser(c);
  const guestUserId = c.req.param('userId');

  const guest = await c.env.DB.prepare(
    `SELECT u.id,
            u.email,
            u.display_name,
            u.status,
            u.external_org,
            u.expires_at,
            u.last_login_at,
            u.invited_by,
            inviter.display_name AS invited_by_name
       FROM users u
       LEFT JOIN users inviter ON inviter.id = u.invited_by
      WHERE u.tenant_id = ? AND u.id = ? AND u.user_type = 'guest'`
  )
    .bind(caller.tenantId, guestUserId)
    .first<GuestSummaryUserRow>();
  if (!guest) {
    return c.json({ error: 'Guest account not found', code: 'GUEST_NOT_FOUND' }, 404);
  }

  const [invitationRows, permissionRows] = await Promise.all([
    c.env.DB.prepare(
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
      .bind(caller.tenantId, guestUserId)
      .all<GuestInvitationRow>(),
    loadGuestPermissionRows(c.env.DB, caller.tenantId, guestUserId),
  ]);

  const invitations = invitationRows.results.map(projectInvitation);

  // Authorization: admins, the inviter, or a member who can view permissions
  // on at least one shared target. Target lookups are tenant-scoped.
  let authorized =
    caller.role === 'sys_admin' || caller.role === 'sec_admin';
  if (!authorized) {
    authorized = invitationRows.results.some(
      (invitation) => invitation.invited_by === caller.id
    );
  }
  if (!authorized) {
    const targets = new Map<
      string,
      { targetType: 'folder' | 'file'; targetId: string }
    >();
    for (const invitation of invitationRows.results) {
      targets.set(`${invitation.target_type}:${invitation.target_id}`, {
        targetType: invitation.target_type,
        targetId: invitation.target_id,
      });
    }
    for (const permission of permissionRows) {
      targets.set(`${permission.target_type}:${permission.target_id}`, {
        targetType: permission.target_type,
        targetId: permission.target_id,
      });
    }
    for (const target of targets.values()) {
      const access = await resolveTargetAccess(
        c.env.DB,
        caller,
        target.targetType,
        target.targetId
      );
      if (access && access.deletedAt === null && can(access.capabilities, 'permission.view')) {
        authorized = true;
        break;
      }
    }
  }
  if (!authorized) {
    return c.json(
      { error: 'Forbidden: guest summary requires resource visibility', code: 'FORBIDDEN' },
      403
    );
  }

  const guestIdentity = {
    id: guest.id,
    email: guest.email,
    displayName: guest.display_name,
    userType: 'guest' as const,
    externalOrg: guest.external_org,
    status: guest.status,
    expiresAt: guest.expires_at,
    lastLoginAt: guest.last_login_at,
    invitedBy: guest.invited_by,
    invitedByName: guest.invited_by_name,
  };
  const guestForAccess = {
    id: guest.id,
    tenantId: caller.tenantId,
  };

  const effectivePermissions: Array<{
    targetType: 'folder' | 'file';
    targetId: string;
    targetName: string | null;
    role: ResourceRole;
    inherited: boolean;
    inheritedFromName: string | null;
    synthesizedRole: ResourceRole | null;
    capabilities: string[];
  }> = [];
  const seenPermissionKeys = new Set<string>();

  for (const permission of permissionRows) {
    const access = await resolveTargetAccess(
      c.env.DB,
      guestForAccess,
      permission.target_type,
      permission.target_id
    );
    if (!access || access.accessMode === null) continue;
    const sources = await loadGuestGrantSources(
      c.env.DB,
      caller.tenantId,
      guestUserId,
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

  const sharedItems = [];
  for (const permission of permissionRows) {
    const access = await resolveTargetAccess(
      c.env.DB,
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
      pathLabel: await loadPathLabel(c.env.DB, caller.tenantId, permission),
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

  const guestPolicy = await getGuestPolicy(c.env.DB, caller.tenantId);
  const advancedRolesEnabled = await areAdvancedRolesEnabled(
    c.env.DB,
    caller.tenantId
  );

  return c.json({
    guest: guestIdentity,
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
    },
    accessSummary: {
      folderCount: sharedItems.filter((item) => item.itemType === 'folder').length,
      fileCount: sharedItems.filter((item) => item.itemType === 'file').length,
      itemCount: sharedItems.length,
      invitationCount: invitations.length,
    },
  });
});
