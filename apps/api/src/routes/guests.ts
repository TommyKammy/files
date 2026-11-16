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
  loadGuestDetail,
  loadGuestInvitation,
  projectGuestInvitation,
  type GuestInvitationRow,
} from '../services/guest-detail';
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

  return c.json({ invitations: rows.results.map(projectGuestInvitation) });
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

  const created = await loadGuestInvitation(c.env.DB, user.tenantId, invitationId);
  return c.json(
    {
      invitation: created ? projectGuestInvitation(created) : null,
      notice: `外部ゲスト「${displayName}」へ招待メールを送信しました。有効期限は ${expiresAt} です。`,
    },
    201
  );
});

/** POST /api/guests/invitations/:id/resend — rotate the token and resend. */
guestsRoutes.post('/invitations/:id/resend', async (c) => {
  const user = getAuthenticatedUser(c);
  const invitation = await loadGuestInvitation(c.env.DB, user.tenantId, c.req.param('id'));
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

  const updated = await loadGuestInvitation(c.env.DB, user.tenantId, invitation.id);
  return c.json({
    invitation: updated ? projectGuestInvitation(updated) : null,
    notice: `招待メールを再送しました（再送回数 ${
      updated?.resend_count ?? invitation.resend_count + 1
    } 回）。`,
  });
});

/** POST /api/guests/invitations/:id/revoke — revoke access and live sessions. */
guestsRoutes.post('/invitations/:id/revoke', async (c) => {
  const user = getAuthenticatedUser(c);
  const invitation = await loadGuestInvitation(c.env.DB, user.tenantId, c.req.param('id'));
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
    return c.json({ ok: true, invitation: projectGuestInvitation(invitation) });
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
  const updated = await loadGuestInvitation(c.env.DB, user.tenantId, invitation.id);
  return c.json({
    ok: true,
    invitation: updated ? projectGuestInvitation(updated) : null,
    notice: '招待を取り消し、ゲストの有効セッションを失効させました。',
  });
});

/* ------------------------------------------------------------------------- */
/* P10-2 / TOM-60 guest detail summary                                        */
/* ------------------------------------------------------------------------- */

/**
 * GET /api/guests/:userId/summary — internal collaborator view of one guest.
 *
 * The projection itself lives in `services/guest-detail.ts` so the admin
 * governance API and this collaboration summary never drift (and so neither can
 * accidentally expose R2 keys, signed URLs, file bytes or raw tokens).
 *
 * Visibility is intentionally narrow: tenant admins, the original inviter, or
 * a member holding `permission.view` on at least one resource shared with the
 * guest.
 */
guestsRoutes.get('/:userId/summary', async (c) => {
  const caller = getAuthenticatedUser(c);
  const guestUserId = c.req.param('userId');
  const detail = await loadGuestDetail(c.env.DB, caller.tenantId, guestUserId);
  if (!detail) {
    return c.json({ error: 'Guest account not found', code: 'GUEST_NOT_FOUND' }, 404);
  }

  let authorized =
    caller.role === 'sys_admin' || caller.role === 'sec_admin';
  if (!authorized) {
    authorized = detail.invitations.some(
      (invitation) => invitation.invitedBy === caller.id
    );
  }
  if (!authorized) {
    const targets = new Map<
      string,
      { targetType: 'folder' | 'file'; targetId: string }
    >();
    for (const invitation of detail.invitations) {
      targets.set(`${invitation.targetType}:${invitation.targetId}`, {
        targetType: invitation.targetType,
        targetId: invitation.targetId,
      });
    }
    for (const item of detail.sharedItems) {
      targets.set(`${item.itemType}:${item.id}`, {
        targetType: item.itemType,
        targetId: item.id,
      });
    }
    for (const target of targets.values()) {
      const access = await resolveTargetAccess(
        c.env.DB,
        caller,
        target.targetType,
        target.targetId
      );
      if (
        access &&
        access.deletedAt === null &&
        can(access.capabilities, 'permission.view')
      ) {
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

  return c.json({
    guest: {
      id: detail.guest.id,
      email: detail.guest.email,
      displayName: detail.guest.displayName,
      userType: detail.guest.userType,
      externalOrg: detail.guest.externalOrg,
      status: detail.guest.status,
      expiresAt: detail.guest.expiresAt,
      lastLoginAt: detail.guest.lastLoginAt,
      invitedBy: detail.guest.invitedBy,
      invitedByName: detail.guest.invitedByName,
    },
    invitations: detail.invitations,
    effectivePermissions: detail.effectivePermissions,
    sharedItems: detail.sharedItems,
    guestPolicy: {
      allowExternalCollaborators: detail.guestPolicy.allowExternalCollaborators,
      externalDomainAllowlist: detail.guestPolicy.externalDomainAllowlist,
      allowGuestElevatedRoles: detail.guestPolicy.allowGuestElevatedRoles,
      guestGrantableRoles: detail.guestPolicy.guestGrantableRoles,
      guestInvitationExpiryDays: detail.guestPolicy.guestInvitationExpiryDays,
    },
    accessSummary: detail.accessSummary,
  });
});
