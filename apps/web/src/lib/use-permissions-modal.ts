'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ApiClientError,
  grantPermission,
  listPermissions,
  revokePermission,
  searchPrincipals,
  updateFolderInvitePolicy as apiUpdateFolderInvitePolicy,
} from '@/lib/files-api';
import { canAccess, capabilitiesForRole } from '@/lib/capabilities';
import {
  INVITE_POLICY_LABEL,
} from '@/lib/invite-policy';
import type {
  Capability,
  EffectiveBreakdownGrant,
  GuestInvitationSummary,
  GuestPolicyProjection,
  InvitePolicy,
  InvitePolicyInfo,
  PermissionEntry,
  PermissionInheritanceMode,
  PrincipalCandidate,
  ResourceRole,
} from '@/types/files';

/**
 * Maps server guardrail codes to actionable Japanese messages. Unknown errors
 * fall back to the API text so the modal never hides a blocking reason.
 */
export function formatPermissionError(
  err: unknown,
  fallback: string
): string {
  if (!(err instanceof ApiClientError)) return fallback;
  const code = err.code?.toUpperCase();
  switch (code) {
    case 'ROLE_FOLDER_ONLY':
      return '投稿系ロール（Uploader / Previewer + Uploader / Viewer + Uploader）はフォルダ専用です。ファイルには付与できません。';
    case 'ADVANCED_ROLES_DISABLED':
      return '高度ロールはテナントポリシーで無効になっています。管理者が /admin のアクセス制御設定で有効化するまで付与できません。';
    case 'LAST_OWNER_PROTECTED':
    case 'LAST_OWNER_LOCKOUT':
      return 'このリソースの最後の Owner を降格・削除することはできません。先に別の Owner を付与してください。';
    case 'OWNER_ESCALATION_BLOCKED':
      return 'Owner ロールを付与できるのは Owner のみです。Co-Owner は権限を昇格できません。';
    case 'INHERITED_PERMISSION_READONLY':
      return '継承された権限は親フォルダ側で変更してください。この画面からは削除できません。';
    case 'WATERFALL_INHERITED_LOCKED': {
      const ancestor =
        typeof err.details?.ancestorFolderName === 'string'
          ? err.details.ancestorFolderName
          : '親フォルダ';
      const role =
        typeof err.details?.inheritedRole === 'string'
          ? err.details.inheritedRole
          : null;
      return `親フォルダ「${ancestor}」から${
        role ? ` ${role} ` : ''
      }権限を継承しているため、この子フォルダで再付与・変更はできません。親フォルダで変更してください。`;
    }
    case 'INVITE_POLICY_RESTRICTED': {
      const policy =
        typeof err.details?.effectiveInvitePolicy === 'string' &&
        err.details.effectiveInvitePolicy in INVITE_POLICY_LABEL
          ? INVITE_POLICY_LABEL[
              err.details.effectiveInvitePolicy as InvitePolicy
            ]
          : '現在の招待ポリシー';
      return `招待ポリシー「${policy}」により、あなたの権限ではメンバーを招待できません。所有者/共同所有者にポリシー変更を依頼してください。`;
    }
    case 'INVITE_POLICY_CANNOT_RELAX': {
      const floor =
        typeof err.details?.inheritedFloor === 'string' &&
        err.details.inheritedFloor in INVITE_POLICY_LABEL
          ? INVITE_POLICY_LABEL[err.details.inheritedFloor as InvitePolicy]
          : '上位フォルダ';
      return `上位の「${floor}」より招待ポリシーを緩めることはできません。同じか、より厳しいポリシーを選択してください。`;
    }
    case 'MANAGE_PERMISSION_REQUIRED':
      return '既存の権限の変更・削除には所有者（Owner）または共同所有者（Co-Owner）の権限が必要です。招待のみの権限では実行できません。';
    case 'ROLE_EXCEEDS_CALLER_CAPABILITIES':
      return '指定したロールはあなたの権限範囲を超えています。所有者/共同所有者の付与や、自分より強い権限の付与はできません。';
    case 'CIRCULAR_HIERARCHY':
    case 'MAX_DEPTH_EXCEEDED':
      return 'フォルダ階層の制約により、この権限操作は実行できません。';
    case 'SUSPENDED_USER_BLOCKED':
      return '停止中のユーザーには権限を付与できません。';
    case 'GUEST_ROLE_FORBIDDEN':
      return '外部ゲストには Owner / Co-Owner を付与できません。Editor はテナントポリシーで許可された場合のみ付与できます。';
    case 'EXTERNAL_COLLABORATORS_DISABLED':
      return '外部ゲストコラボレーターがテナントポリシーで無効です。管理者が /admin で有効化してください。';
    case 'EXTERNAL_DOMAIN_NOT_ALLOWED':
      return 'このメールドメインは外部ゲストの許可リストに含まれていません。';
    case 'GUEST_ACCOUNT_INACTIVE':
      return 'ゲストアカウントは停止されています。管理者にお問い合わせください。';
    case 'GUEST_ACCOUNT_EXPIRED':
      return 'ゲストアカウントの有効期限が切れています。';
    case 'INVITATION_NOT_PENDING':
      return 'この招待は再送できない状態です（受諾済み・取消済み・期限切れ）。';
    case 'INVITATION_NOT_FOUND':
      return 'ゲスト招待が見つかりません。画面を再読み込みしてください。';
    default:
      return err.message || fallback;
  }
}

export function usePermissionsModal({
  targetType,
  targetId,
  effectiveRole,
}: {
  targetType: 'folder' | 'file';
  targetId: string;
  effectiveRole: ResourceRole;
}) {
  const [permissions, setPermissions] = useState<PermissionEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>(() =>
    capabilitiesForRole(effectiveRole)
  );
  const [advancedRolesEnabled, setAdvancedRolesEnabled] = useState(false);
  const [permissionInheritanceMode, setPermissionInheritanceMode] =
    useState<PermissionInheritanceMode>('additive');
  const [invitePolicy, setInvitePolicy] = useState<InvitePolicyInfo | null>(null);
  const [grantableRoles, setGrantableRoles] = useState<ResourceRole[]>([]);
  const [guestInvitations, setGuestInvitations] = useState<
    GuestInvitationSummary[]
  >([]);
  const [guestPolicy, setGuestPolicy] = useState<GuestPolicyProjection | null>(
    null
  );
  const [canInvite, setCanInvite] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [effectiveBreakdown, setEffectiveBreakdown] = useState<
    EffectiveBreakdownGrant[]
  >([]);
  const [serverEffectiveRole, setServerEffectiveRole] =
    useState<ResourceRole | null>(effectiveRole);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<PrincipalCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPrincipal, setSelectedPrincipal] =
    useState<PrincipalCandidate | null>(null);
  const [role, setRole] = useState<ResourceRole>(
    targetType === 'file' && effectiveRole === 'owner' ? 'owner' : 'viewer'
  );
  const [submitting, setSubmitting] = useState(false);

  const canManage = useMemo(
    () =>
      canAccess({ capabilities, effectiveRole: serverEffectiveRole }, 'permission.manage'),
    [capabilities, serverEffectiveRole]
  );

  const selectedPrincipalLock = useMemo(() => {
    if (permissionInheritanceMode !== 'waterfall' || !selectedPrincipal) {
      return null;
    }
    const matching = permissions.filter(
      (entry) =>
        entry.granteeType === selectedPrincipal.type &&
        entry.granteeId === selectedPrincipal.id
    );
    const inherited = matching.find((entry) => entry.inherited);
    if (inherited) {
      return {
        sourceName: inherited.sourceName ?? inherited.ancestorFolderName ?? '親フォルダ',
        role: inherited.role,
        inherited: true,
      };
    }
    const locked = matching.find((entry) => entry.waterfallLocked);
    if (locked) {
      return {
        sourceName:
          locked.ancestorFolderName ?? locked.sourceName ?? '親フォルダ',
        role: locked.ancestorRole ?? locked.role,
        inherited: false,
      };
    }
    return null;
  }, [permissionInheritanceMode, selectedPrincipal, permissions]);

  async function reloadPermissions() {
    setLoading(true);
    setError(null);
    try {
      const res = await listPermissions(targetType, targetId);
      const resolvedCapabilities =
        res.effectiveCapabilities ?? res.capabilities ?? capabilitiesForRole(effectiveRole);
      setPermissions(res.permissions);
      setCapabilities(resolvedCapabilities);
      setAdvancedRolesEnabled(Boolean(res.advancedRolesEnabled));
      setPermissionInheritanceMode(
        res.permissionInheritanceMode ?? 'additive'
      );
      setInvitePolicy(res.invitePolicy ?? null);
      setGuestInvitations(res.guestInvitations ?? []);
      setGuestPolicy(res.guestPolicy ?? null);
      const roles = res.grantableRoles ?? [];
      setGrantableRoles(roles);
      setCanInvite(
        typeof res.canInvite === 'boolean'
          ? res.canInvite
          : canAccess(
              {
                capabilities: resolvedCapabilities,
                effectiveRole: res.effectiveRole ?? effectiveRole,
              },
              'permission.invite'
            )
      );
      setEffectiveBreakdown(res.effectiveBreakdown ?? []);
      setServerEffectiveRole(res.effectiveRole ?? effectiveRole);
      if (roles.length > 0) {
        setRole((previous) => {
          if (roles.includes(previous)) return previous;
          if (targetType === 'file' && roles.includes('owner')) return 'owner';
          return roles.includes('viewer') ? 'viewer' : roles[0]!;
        });
      }
    } catch (err) {
      setError(formatPermissionError(err, '権限一覧の取得に失敗しました'));
      setCanInvite(false);
      setGrantableRoles([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reloadPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetType, targetId]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !canInvite) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(() => {
      searchPrincipals(trimmed, 'all')
        .then((res) => {
          if (!cancelled) setCandidates(res.principals);
        })
        .catch(() => {
          if (!cancelled) setCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, canInvite]);

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPrincipal || submitting || !canInvite) return;
    if (selectedPrincipalLock) {
      setError(
        `親フォルダ「${selectedPrincipalLock.sourceName}」から権限継承中のため、この子フォルダで再付与・変更はできません。親フォルダで変更してください。`
      );
      return;
    }
    if (grantableRoles.length > 0 && !grantableRoles.includes(role)) {
      setError(
        '選択したロールは現在の招待ポリシーまたはあなたの権限範囲では付与できません。'
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await grantPermission({
        targetType,
        targetId,
        granteeType: selectedPrincipal.type,
        granteeId: selectedPrincipal.id,
        role,
      });
      setSelectedPrincipal(null);
      setQuery('');
      setCandidates([]);
      await reloadPermissions();
    } catch (err) {
      setError(formatPermissionError(err, '権限の付与に失敗しました'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(entry: PermissionEntry) {
    if (entry.inherited || !canManage) return;
    setError(null);
    try {
      await revokePermission(entry.id);
      await reloadPermissions();
    } catch (err) {
      setError(formatPermissionError(err, '権限の削除に失敗しました'));
    }
  }

  async function handleUpdateFolderInvitePolicy(
    nextPolicy: InvitePolicy | null
  ): Promise<boolean> {
    if (targetType !== 'folder' || policySaving) return false;
    setPolicySaving(true);
    setError(null);
    setPolicyNotice(null);
    try {
      await apiUpdateFolderInvitePolicy(targetId, nextPolicy);
      await reloadPermissions();
      setPolicyNotice(
        nextPolicy === null
          ? 'フォルダの上書き設定を解除し、上位の招待ポリシーを継承します。'
          : `フォルダ招待ポリシーを「${INVITE_POLICY_LABEL[nextPolicy]}」に更新しました。`
      );
      return true;
    } catch (err) {
      setError(
        formatPermissionError(err, 'フォルダ招待ポリシーの更新に失敗しました')
      );
      return false;
    } finally {
      setPolicySaving(false);
    }
  }

  return {
    permissions,
    capabilities,
    advancedRolesEnabled,
    permissionInheritanceMode,
    invitePolicy,
    grantableRoles,
    guestInvitations,
    guestPolicy,
    canInvite,
    policySaving,
    policyNotice,
    setPolicyNotice,
    effectiveBreakdown,
    effectiveRole: serverEffectiveRole ?? effectiveRole,
    loading,
    error,
    query,
    setQuery,
    candidates,
    setCandidates,
    searching,
    selectedPrincipal,
    setSelectedPrincipal,
    selectedPrincipalLock,
    role,
    setRole,
    submitting,
    canManage,
    handleGrant,
    handleRevoke,
    handleUpdateFolderInvitePolicy,
    reloadPermissions,
  };
}
