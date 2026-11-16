import type { ResourceRole } from '../types/api';
import { ADVANCED_RESOURCE_ROLES } from './capabilities';
import type { GuestPolicy } from './external-guests';

/**
 * Pure P10-2 / TOM-60 helpers shared by the guest collaboration APIs.
 *
 * The invitation e-mail preview is deliberately rebuilt from structured data
 * instead of the delivered message: the raw invitation token is never stored in
 * a readable form and must never appear in an API response.
 */

export interface GuestMailPreview {
  subject: string;
  bodyPreview: string;
}

export interface GuestMailPreviewInput {
  displayName: string;
  externalOrg: string | null;
  targetType: 'folder' | 'file';
  targetName: string | null;
  role: ResourceRole;
  expiresAt: string;
  invitedByName?: string | null;
}

const REDACTED_INVITATION_LINK = '（招待リンクはメール本文に記載されています）';

export const GUEST_INVITATION_MAIL_SUBJECT =
  '【Files】外部ゲストコラボレーターの招待';

export function buildGuestInvitationMailPreview(
  input: GuestMailPreviewInput
): GuestMailPreview {
  const targetName =
    input.targetName ?? (input.targetType === 'folder' ? '共有フォルダ' : '共有ファイル');
  const bodyPreview = [
    `${input.displayName} 様`,
    '',
    'Files のワークスペースへ外部ゲストコラボレーターとして招待されました。',
    `共有対象: ${targetName}`,
    input.externalOrg ? `外部組織: ${input.externalOrg}` : null,
    `付与ロール: ${input.role}`,
    input.invitedByName ? `招待者: ${input.invitedByName}` : null,
    `招待の有効期限: ${new Date(input.expiresAt).toISOString()}`,
    '',
    '以下の URL から招待を承諾し、メールに届く 6 桁の認証コードでサインインしてください。',
    REDACTED_INVITATION_LINK,
    '',
    'このメールに心当たりがない場合は破棄してください。',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return {
    subject: GUEST_INVITATION_MAIL_SUBJECT,
    bodyPreview,
  };
}

/**
 * Roles the guest policy allows for the given target. `owner`, `co_owner` are
 * never returned. `editor` requires `allowGuestElevatedRoles`; the uploader
 * family requires folder targeting and `advanced_roles_enabled`.
 */
export function guestGrantableRoles(
  policy: Pick<GuestPolicy, 'allowGuestElevatedRoles'>,
  options: { advancedRolesEnabled: boolean; targetType: 'folder' | 'file' }
): ResourceRole[] {
  const base: ResourceRole[] = ['viewer', 'previewer'];
  if (options.targetType === 'folder' && policy.allowGuestElevatedRoles) {
    base.push('editor');
  }
  if (options.targetType === 'folder' && options.advancedRolesEnabled) {
    base.push('uploader', 'viewer_uploader', 'previewer_uploader');
  }
  return base;
}

export function isFolderOnlyGuestRole(role: ResourceRole): boolean {
  return ADVANCED_RESOURCE_ROLES.has(role);
}

/** Camel-cased guest policy projection used by `GET /api/permissions`. */
export function projectGuestPolicy(
  policy: GuestPolicy,
  options: { advancedRolesEnabled: boolean; targetType: 'folder' | 'file' }
) {
  return {
    allowExternalCollaborators: policy.allowExternalCollaborators,
    externalDomainAllowlist: [...policy.externalDomainAllowlist],
    allowGuestElevatedRoles: policy.allowGuestElevatedRoles,
    guestGrantableRoles: guestGrantableRoles(policy, options),
    guestInvitationExpiryDays: policy.guestInvitationExpiryDays,
  };
}
