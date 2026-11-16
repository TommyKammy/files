import {
  ADVANCED_RESOURCE_ROLES,
  RESOURCE_ROLES,
  ROLE_META,
  canAccess,
} from '@/lib/capabilities';
import { ApiClientError } from '@/lib/files-api/core';
import { formatDateTime } from '@/lib/formatters';
import type {
  Capability,
  ClassificationLabel,
  GuestInvitationStatus,
  GuestMailPreview,
  GuestPolicyProjection,
  GuestSummaryResponse,
  ResourceRole,
  UserType,
} from '@/types/files';

/**
 * Pure P10-2 / TOM-60 guest collaboration view helpers.
 *
 * These functions are intentionally free of React so the same rules are unit
 * tested for the permissions modal, the guest workspace banner and the session
 * recovery screens.
 */

export interface GuestRoleOption {
  role: ResourceRole;
  label: string;
  description: string;
  enabled: boolean;
  reason: string | null;
}

export interface GuestRoleConstraintInput {
  targetType: 'folder' | 'file';
  advancedRolesEnabled: boolean;
  allowGuestElevatedRoles: boolean;
  /** Roles the caller may grant at all (server `grantableRoles`). */
  grantableRoles?: readonly ResourceRole[];
}

/**
 * Every guest-assignable candidate, including forbidden ones so the UI can
 * explain *why* they are unavailable. `owner` / `co_owner` are never enabled;
 * `editor` is opt-in through `allowGuestElevatedRoles`; the uploader family is
 * folder-only and requires advanced roles.
 */
export function guestRoleOptions(
  input: GuestRoleConstraintInput
): GuestRoleOption[] {
  return RESOURCE_ROLES.map((role) => {
    const meta = ROLE_META[role];
    let reason: string | null = null;
    if (role === 'owner' || role === 'co_owner') {
      reason = 'ゲストには所有者・共同所有者を付与できません';
    } else if (role === 'editor' && !input.allowGuestElevatedRoles) {
      reason =
        '既定のゲストポリシーでは Editor は選択できません。管理者が「ゲストへの高権限ロール」を許可した場合のみ付与できます';
    } else if (ADVANCED_RESOURCE_ROLES.has(role) && input.targetType !== 'folder') {
      reason = '投稿系ロールはフォルダ専用です（ファイルには付与できません）';
    } else if (ADVANCED_RESOURCE_ROLES.has(role) && !input.advancedRolesEnabled) {
      reason = '高度ロールがテナントポリシーで無効です';
    } else if (
      input.grantableRoles &&
      !input.grantableRoles.includes(role)
    ) {
      reason =
        '現在の招待ポリシーまたはあなたの権限範囲では付与できません';
    }
    return {
      role,
      label: meta.label,
      description: meta.description,
      enabled: reason === null,
      reason,
    };
  });
}

export function guestAssignableRoleOptions(
  input: GuestRoleConstraintInput
): GuestRoleOption[] {
  return guestRoleOptions(input).filter((option) => option.enabled);
}

export const GUEST_SHARED_LINK_NOTE =
  '外部ゲストはアカウント単位の招待です。共有リンクと異なり、サインイン・有効期限・監査ログ・ロール制約が適用され、管理画面やルートフォルダ作成にはアクセスできません。';

export const GUEST_POLICY_DISABLED_NOTICE =
  '外部ゲストコラボレーターはテナントポリシーで無効です。管理者が /admin の「外部ゲストコラボレーター」設定で許可し、外部ドメインを追加すると招待できます。';

export function guestDomainGuidance(allowlist: readonly string[]): string {
  if (allowlist.length === 0) {
    return '外部ドメインの許可リストが空です。フェイルクローズのため、管理者が許可ドメインを追加するまで招待できません。';
  }
  return `招待できるメールドメイン: ${allowlist.join(', ')}`;
}

export function isGuestInvitationExpired(
  invitation: { status: GuestInvitationStatus; expiresAt: string },
  nowMs = Date.now()
): boolean {
  if (invitation.status !== 'pending') return invitation.status === 'expired';
  const expires = Date.parse(invitation.expiresAt);
  return Number.isFinite(expires) && expires <= nowMs;
}

export function guestInvitationStatusLabel(
  status: GuestInvitationStatus
): string {
  switch (status) {
    case 'pending':
      return '招待中';
    case 'accepted':
      return '受諾済み';
    case 'expired':
      return '期限切れ';
    case 'revoked':
      return '停止/取消済み';
  }
}

export const GUEST_INVITATION_MAIL_SUBJECT =
  '【Files】外部ゲストコラボレーターの招待';

const INVITATION_LINK_PLACEHOLDER =
  '（招待リンクはメール本文に記載されています）';

export interface GuestMailPreviewDraftInput {
  displayName: string;
  externalOrg?: string | null;
  targetType: 'folder' | 'file';
  targetName: string;
  role: ResourceRole;
  expiresAt: string;
  invitedByName?: string | null;
}

/** Local, pre-send preview. Contains no invitation token by construction. */
export function buildGuestMailPreviewDraft(
  input: GuestMailPreviewDraftInput
): GuestMailPreview {
  const displayName = input.displayName.trim() || 'ご担当者';
  const bodyPreview = [
    `${displayName} 様`,
    '',
    'Files のワークスペースへ外部ゲストコラボレーターとして招待されました。',
    `共有対象: ${input.targetName}`,
    input.externalOrg?.trim()
      ? `外部組織: ${input.externalOrg.trim()}`
      : null,
    `付与ロール: ${ROLE_META[input.role]?.label ?? input.role}`,
    input.invitedByName ? `招待者: ${input.invitedByName}` : null,
    `招待の有効期限: ${formatDateTime(input.expiresAt)}`,
    '',
    '以下の URL から招待を承諾し、メールに届く 6 桁の認証コードでサインインしてください。',
    INVITATION_LINK_PLACEHOLDER,
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

const TOKEN_PATTERN = /((?:token|unlockToken)=)[^\s&"'<>]+/gi;
const AUTH_CODE_PATTERN = /((?:認証コード|招待コード|OTP)\s*[:：]\s*)\d{4,8}/g;
const INVITATION_URL_PATTERN =
  /https?:\/\/[^\s]*\/guest\/accept\?[^\s]+/gi;

/**
 * Defence-in-depth rendering for `mailPreview` from the API. Even though the
 * server never stores a response-visible token, any token, accept URL or OTP
 * that reaches the browser is redacted before display.
 */
export function formatGuestMailPreview(preview: GuestMailPreview | null | undefined): {
  subject: string;
  bodyPreview: string;
  redacted: boolean;
} {
  if (!preview) {
    return {
      subject: GUEST_INVITATION_MAIL_SUBJECT,
      bodyPreview: INVITATION_LINK_PLACEHOLDER,
      redacted: false,
    };
  }
  const original = preview.bodyPreview ?? '';
  let bodyPreview = original
    .replace(INVITATION_URL_PATTERN, INVITATION_LINK_PLACEHOLDER)
    .replace(TOKEN_PATTERN, '$1[REDACTED]')
    .replace(AUTH_CODE_PATTERN, '$1******')
    .replace(/\b\d{6}\b/g, '******');
  // Normalise whitespace while preserving intentional blank lines.
  bodyPreview = bodyPreview
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  return {
    subject: preview.subject || GUEST_INVITATION_MAIL_SUBJECT,
    bodyPreview,
    redacted: bodyPreview !== original.trim(),
  };
}

export interface GuestSessionIssue {
  code: string;
  title: string;
  description: string;
  actionHref: '/guest/login';
  actionLabel: string;
}

const GUEST_SESSION_ISSUE_CODES = new Set([
  'GUEST_ACCOUNT_EXPIRED',
  'GUEST_ACCOUNT_SUSPENDED',
  'GUEST_ACCOUNT_INACTIVE',
  'SESSION_EXPIRED_OR_REVOKED',
  'INVITATION_REVOKED',
  'INVITATION_EXPIRED',
  'INVITATION_NOT_ACCEPTED',
  'EXTERNAL_COLLABORATORS_DISABLED',
  'EXTERNAL_DOMAIN_NOT_ALLOWED',
]);

export function isGuestSessionIssueCode(code: string | null | undefined): boolean {
  return Boolean(code && GUEST_SESSION_ISSUE_CODES.has(code));
}

export function guestSessionIssueFromCode(
  code: string | null | undefined,
  userType: UserType | null | undefined
): GuestSessionIssue | null {
  if (!code) return null;
  if (userType !== 'guest' && code !== 'INVITATION_REVOKED' && code !== 'INVITATION_EXPIRED') {
    return null;
  }
  const base = {
    code,
    actionHref: '/guest/login' as const,
    actionLabel: '外部ゲストサインイン',
  };
  switch (code) {
    case 'GUEST_ACCOUNT_EXPIRED':
      return {
        ...base,
        title: 'ゲストアカウントの有効期限が切れました',
        description:
          '管理者が設定したアカウント有効期限を過ぎています。招待元の組織に再発行を依頼してください。',
      };
    case 'GUEST_ACCOUNT_SUSPENDED':
    case 'GUEST_ACCOUNT_INACTIVE':
      return {
        ...base,
        title: 'ゲストアカウントが停止されています',
        description:
          '招待の取消または管理者操作によりアカウントが停止されました。招待元の組織にお問い合わせください。',
      };
    case 'SESSION_EXPIRED_OR_REVOKED':
      return {
        ...base,
        title: 'ゲストセッションの有効期限が切れました',
        description:
          'セキュリティのため、もう一度認証コードでサインインしてください。',
      };
    case 'INVITATION_REVOKED':
      return {
        ...base,
        title: 'ゲスト招待が取り消されました',
        description:
          '共有先の所有者または管理者が招待を取り消しました。アクセスが必要な場合は再招待を依頼してください。',
      };
    case 'INVITATION_EXPIRED':
      return {
        ...base,
        title: 'ゲスト招待の有効期限が切れています',
        description:
          '招待リンクの有効期限が過ぎています。招待元の組織に再送を依頼してください。',
      };
    case 'INVITATION_NOT_ACCEPTED':
      return {
        ...base,
        title: 'ゲスト招待が未承諾です',
        description:
          '招待メールの URL から承諾を完了してください。',
      };
    case 'EXTERNAL_COLLABORATORS_DISABLED':
      return {
        ...base,
        title: '外部ゲスト連携が無効になりました',
        description:
          'テナント管理者が外部ゲストコラボレーターを無効化しました。アクセスが必要な場合は管理者にお問い合わせください。',
      };
    case 'EXTERNAL_DOMAIN_NOT_ALLOWED':
      return {
        ...base,
        title: '外部ドメインが許可されていません',
        description:
          'このメールドメインは許可リストから削除されました。管理者にお問い合わせください。',
      };
    default:
      return null;
  }
}

export function guestSessionIssueFromError(
  err: unknown,
  options: { userType?: UserType | null } = {}
): GuestSessionIssue | null {
  if (!(err instanceof ApiClientError)) return null;
  const code =
    err.code ??
    (err.status === 401 ? 'SESSION_EXPIRED_OR_REVOKED' : undefined);
  const issue = guestSessionIssueFromCode(code, options.userType ?? null);
  if (issue) return issue;
  if (err.status === 401 && options.userType === 'guest') {
    return {
      code: 'SESSION_EXPIRED_OR_REVOKED',
      title: 'ゲストセッションの有効期限が切れました',
      description:
        'セキュリティのため、もう一度認証コードでサインインしてください。',
      actionHref: '/guest/login',
      actionLabel: '外部ゲストサインイン',
    };
  }
  return null;
}

export interface GuestWorkspaceBannerModel {
  externalOrg: string | null;
  expiresAt: string | null;
  expiresLabel: string;
  role: ResourceRole;
  roleLabel: string;
  allowed: string[];
  denied: string[];
}

/**
 * Derives the banner copy from the effective capabilities, never from a linear
 * role rank. `viewer_uploader` and `previewer` therefore produce different
 * allowed/denied lists even though both can preview.
 */
export function buildGuestWorkspaceBanner(input: {
  externalOrg?: string | null;
  expiresAt?: string | null;
  role: ResourceRole;
  capabilities?: readonly Capability[] | null;
}): GuestWorkspaceBannerModel {
  const target = {
    effectiveRole: input.role,
    capabilities: input.capabilities ?? null,
  };
  const allowed: string[] = [];
  if (canAccess(target, 'item.upload_new')) allowed.push('アップロード');
  if (canAccess(target, 'item.preview')) allowed.push('プレビュー');
  if (canAccess(target, 'item.download')) allowed.push('ダウンロード');
  if (canAccess(target, 'item.upload_version')) {
    allowed.push('新バージョンのアップロード');
  }

  const denied: string[] = [];
  if (
    !canAccess(target, 'permission.manage') &&
    !canAccess(target, 'permission.invite')
  ) {
    denied.push('権限管理');
  }
  if (
    !canAccess(target, 'item.delete') &&
    !canAccess(target, 'folder.delete')
  ) {
    denied.push('削除');
  }
  denied.push('ルートフォルダ作成');

  return {
    externalOrg: input.externalOrg ?? null,
    expiresAt: input.expiresAt ?? null,
    expiresLabel: formatDateTime(input.expiresAt ?? null),
    role: input.role,
    roleLabel: ROLE_META[input.role]?.label ?? input.role,
    allowed: allowed.length > 0 ? allowed : ['（この共有フォルダでは閲覧操作なし）'],
    denied,
  };
}

const CLASSIFICATION_LABELS: Record<ClassificationLabel, string> = {
  confidential: '極秘 (Confidential)',
  internal: '社内 (Internal)',
  public: '公開 (Public)',
  unset: '未設定 (Unset)',
};

export interface GuestSummaryView {
  guest: {
    displayName: string;
    email: string;
    externalOrgLabel: string;
    statusLabel: string;
    expiresLabel: string;
    lastLoginLabel: string;
    invitedByLabel: string;
  };
  summaryLine: string;
  invitations: Array<{
    id: string;
    statusLabel: string;
    roleLabel: string;
    expiresLabel: string;
    targetName: string;
    mailPreview: ReturnType<typeof formatGuestMailPreview>;
  }>;
  effectivePermissions: Array<{
    key: string;
    targetLabel: string;
    roleLabel: string;
    sourceLabel: string;
    synthesizedLabel: string;
  }>;
  sharedItems: Array<{
    key: string;
    kindLabel: string;
    name: string;
    pathLabel: string;
    classificationLabel: string;
    roleLabel: string;
  }>;
}

/**
 * Converts the `/api/guests/:userId/summary` payload into the exact strings the
 * guest detail card shows. Missing optional values degrade to em-dashes rather
 * than throwing, so a partially migrated API cannot blank the modal.
 */
export function formatGuestSummary(
  summary: GuestSummaryResponse
): GuestSummaryView {
  const guest = summary.guest;
  const invitations = (summary.invitations ?? []).map((invitation) => ({
    id: invitation.id,
    statusLabel: guestInvitationStatusLabel(invitation.status),
    roleLabel: ROLE_META[invitation.role]?.label ?? invitation.role,
    expiresLabel: formatDateTime(invitation.expiresAt),
    targetName: invitation.targetName ?? invitation.targetId,
    mailPreview: formatGuestMailPreview(invitation.mailPreview),
  }));
  const effectivePermissions = (summary.effectivePermissions ?? []).map(
    (permission, index) => ({
      key: `${permission.targetType}:${permission.targetId}:${index}`,
      targetLabel: `${permission.targetType === 'folder' ? 'フォルダ' : 'ファイル'}: ${
        permission.targetName ?? permission.targetId
      }`,
      roleLabel: ROLE_META[permission.role]?.label ?? permission.role,
      sourceLabel: permission.inherited
        ? `継承元: ${permission.inheritedFromName ?? '親フォルダ'}`
        : '直接付与',
      synthesizedLabel: permission.synthesizedRole
        ? ROLE_META[permission.synthesizedRole]?.label ??
          permission.synthesizedRole
        : '—',
    })
  );
  const sharedItems = (summary.sharedItems ?? []).map((item) => ({
    key: `${item.itemType}:${item.id}`,
    kindLabel: item.itemType === 'folder' ? 'フォルダ' : 'ファイル',
    name: item.name,
    pathLabel: item.pathLabel,
    classificationLabel:
      CLASSIFICATION_LABELS[item.classification] ?? item.classification,
    roleLabel: item.effectiveRole
      ? ROLE_META[item.effectiveRole]?.label ?? item.effectiveRole
      : '—',
  }));
  const summaryLine = `共有 ${summary.accessSummary?.itemCount ?? sharedItems.length} 件（フォルダ ${
    summary.accessSummary?.folderCount ?? 0
  } / ファイル ${summary.accessSummary?.fileCount ?? 0}）・招待 ${
    summary.accessSummary?.invitationCount ?? invitations.length
  } 件`;
  return {
    guest: {
      displayName: guest.displayName,
      email: guest.email,
      externalOrgLabel: guest.externalOrg ?? '外部組織未設定',
      statusLabel: guest.status === 'active' ? '有効' : '停止',
      expiresLabel: formatDateTime(guest.expiresAt),
      lastLoginLabel: formatDateTime(guest.lastLoginAt),
      invitedByLabel:
        guest.invitedByName ?? guest.invitedBy ?? '招待者不明',
    },
    summaryLine,
    invitations,
    effectivePermissions,
    sharedItems,
  };
}

/** Roles the API marks as guest-grantable, falling back to local policy. */
export function guestGrantableRoleSet(
  policy: GuestPolicyProjection | null | undefined,
  fallback: readonly ResourceRole[]
): Set<ResourceRole> {
  return new Set(policy?.guestGrantableRoles ?? fallback);
}
