import type {
  AdminOffboardingFileRequestsAction,
  AdminOffboardingPreviewResponse,
  AdminOffboardingResponse,
  AdminOffboardingSharedLinksAction,
  AdminOffboardingTransferCandidate,
  AdminOffboardingUserAction,
  UserRole,
} from '@/types/files';

/**
 * P11-4 / TOM-70 pure helpers for the member offboarding wizard.
 *
 * RBAC, guard copy, candidate filtering, confirmation matching and result
 * summaries live here so the wizard behaviour is unit-testable without React.
 */

export const OFFBOARDING_CONFIRMATION_TEXT = 'OFFBOARD';

export const OFFBOARDING_SHARED_LINKS_LABELS: Record<
  AdminOffboardingSharedLinksAction,
  string
> = {
  transfer_owner: '後任メンバーへ移管',
  revoke_all: 'すべて一括失効',
};

export const OFFBOARDING_FILE_REQUESTS_LABELS: Record<
  AdminOffboardingFileRequestsAction,
  string
> = {
  transfer_owner: '後任メンバーへ移管',
  deactivate_all: 'すべて一括停止',
};

export const OFFBOARDING_USER_ACTION_LABELS: Record<
  AdminOffboardingUserAction,
  string
> = {
  suspend: 'アカウントを停止',
  keep_status: 'ステータスを維持',
};

export type AdminOffboardingViewerRole = UserRole | null | undefined;

/** sys_admin and sec_admin may review the inventory. */
export function canViewMemberOffboarding(
  role: AdminOffboardingViewerRole
): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

/** sys_admin and sec_admin may open the inventory (preview). */
export function canOpenMemberOffboarding(
  role: AdminOffboardingViewerRole
): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

/** Only sys_admin may execute an offboarding. */
export function canExecuteMemberOffboarding(
  role: AdminOffboardingViewerRole
): boolean {
  return role === 'sys_admin';
}

/**
 * Opening the wizard is allowed for both admin roles. sec_admin can inspect the
 * inventory, while the execute button remains sys_admin-only inside the modal.
 */
export function memberOffboardingOpenGuardReason(input: {
  viewerRole: AdminOffboardingViewerRole;
  viewerId: string | null | undefined;
  member: Pick<AdminOffboardingPreviewResponse['user'], 'id' | 'role' | 'status'>;
  activeSysAdminCount: number;
}): string | null {
  if (!canOpenMemberOffboarding(input.viewerRole)) {
    return '退職/移管の表示は管理者専用です。';
  }
  if (input.viewerRole === 'sec_admin') return null;
  return memberOffboardingGuardReason(input);
}

export function memberCanOpenOffboarding(input: {
  viewerRole: AdminOffboardingViewerRole;
  viewerId: string | null | undefined;
  member: Pick<AdminOffboardingPreviewResponse['user'], 'id' | 'role' | 'status'>;
  activeSysAdminCount: number;
}): boolean {
  return memberOffboardingOpenGuardReason(input) === null;
}

export function memberOffboardingGuardReason(input: {
  viewerRole: AdminOffboardingViewerRole;
  viewerId: string | null | undefined;
  member: Pick<AdminOffboardingPreviewResponse['user'], 'id' | 'role' | 'status'>;
  activeSysAdminCount: number;
}): string | null {
  if (!canExecuteMemberOffboarding(input.viewerRole)) {
    return '退職/移管の実行は sys_admin 専用です。';
  }
  if (!input.viewerId || input.member.id === input.viewerId) {
    return '自分自身はオフボーディングできません。';
  }
  if (
    input.member.role === 'sys_admin' &&
    input.member.status === 'active' &&
    input.activeSysAdminCount <= 1
  ) {
    return '最後の有効な sys_admin はオフボーディングできません。';
  }
  return null;
}

export function memberCanBeOffboarded(input: {
  viewerRole: AdminOffboardingViewerRole;
  viewerId: string | null | undefined;
  member: Pick<AdminOffboardingPreviewResponse['user'], 'id' | 'role' | 'status'>;
  activeSysAdminCount: number;
}): boolean {
  return memberOffboardingGuardReason(input) === null;
}

export function filterOffboardingTransferCandidates(
  candidates: readonly AdminOffboardingTransferCandidate[],
  query: string
): AdminOffboardingTransferCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter((candidate) => {
    const haystack = [
      candidate.id,
      candidate.email,
      candidate.displayName,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function offboardingRequiresTransfer(input: {
  ownedFolderCount: number;
  sharedLinksAction: AdminOffboardingSharedLinksAction;
  fileRequestsAction: AdminOffboardingFileRequestsAction;
}): boolean {
  return (
    input.ownedFolderCount > 0 ||
    input.sharedLinksAction === 'transfer_owner' ||
    input.fileRequestsAction === 'transfer_owner'
  );
}

/** `OFFBOARD` or the target email (case-insensitive) satisfies confirmation. */
export function matchesOffboardingConfirmation(
  input: string,
  targetEmail: string
): boolean {
  const normalized = input.trim();
  return (
    normalized === OFFBOARDING_CONFIRMATION_TEXT ||
    normalized.toLowerCase() === targetEmail.trim().toLowerCase()
  );
}

export function summarizeOffboardingActions(input: {
  sharedLinksAction: AdminOffboardingSharedLinksAction;
  fileRequestsAction: AdminOffboardingFileRequestsAction;
  userAction: AdminOffboardingUserAction;
}): string {
  return `共有リンク: ${OFFBOARDING_SHARED_LINKS_LABELS[input.sharedLinksAction]} / ファイルリクエスト: ${OFFBOARDING_FILE_REQUESTS_LABELS[input.fileRequestsAction]} / アカウント: ${OFFBOARDING_USER_ACTION_LABELS[input.userAction]}`;
}

export function formatOffboardingResultSummary(
  result: Pick<AdminOffboardingResponse, 'summary'>
): string {
  const summary = result.summary;
  return [
    `フォルダ ${summary.transferredFolderCount} 件移管`,
    `直接権限 ${summary.directPermissionsRevoked} 件剥奪`,
    `共有リンク 移管 ${summary.sharedLinksTransferred} 件 / 失効 ${summary.sharedLinksRevoked} 件`,
    `ファイルリクエスト 移管 ${summary.fileRequestsTransferred} 件 / 停止 ${summary.fileRequestsDeactivated} 件`,
    `セッション ${summary.sessionsRevoked} 件失効`,
    `ロック ${summary.locksReleased} 件解放`,
  ].join(' / ');
}

export function createOffboardingIdempotencyKey(memberId: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `admin-member-offboard-${memberId}-${random}`;
}
