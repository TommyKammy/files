import type { Context } from 'hono';
import { resolveTargetAccess } from '../../services/authorization';
import {
  getGuestPolicy,
  type GuestPolicy,
} from '../../services/external-guests';
import {
  computeEffectivePermissionsCapabilities,
  isRoleWithinCapabilitySubset,
  resolveEffectiveInvitePolicy,
} from '../../services/invite-policy';
import {
  MailDeliveryError,
  MailProviderConfigurationError,
  resolveMailProvider,
} from '../../services/mail-provider';
import type { AuthUser, ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import { getCallbackBaseOrigin } from '../auth/shared';

export const VALID_TARGET_TYPES = new Set(['folder', 'file']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface GuestUserRow {
  id: string;
  email: string;
  display_name: string;
  user_type: 'member' | 'guest';
  status: 'active' | 'suspended';
  expires_at: string | null;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 254 || !EMAIL_RE.test(value)) return null;
  return value;
}

export interface AuthorizationResult {
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
export async function authorizeInvitationTarget(
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

export async function sendInvitationMail(
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

export function mailErrorResponse(c: Context<OidcHonoEnv>, err: unknown): Response {
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
