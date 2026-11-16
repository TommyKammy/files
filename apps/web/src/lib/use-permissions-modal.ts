'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ApiClientError,
  grantPermission,
  listPermissions,
  revokePermission,
  searchPrincipals,
} from '@/lib/files-api';
import { canAccess, capabilitiesForRole } from '@/lib/capabilities';
import type {
  Capability,
  EffectiveBreakdownGrant,
  PermissionEntry,
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
    case 'CIRCULAR_HIERARCHY':
    case 'MAX_DEPTH_EXCEEDED':
      return 'フォルダ階層の制約により、この権限操作は実行できません。';
    case 'SUSPENDED_USER_BLOCKED':
      return '停止中のユーザーには権限を付与できません。';
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

  async function reloadPermissions() {
    setLoading(true);
    setError(null);
    try {
      const res = await listPermissions(targetType, targetId);
      setPermissions(res.permissions);
      setCapabilities(res.capabilities ?? capabilitiesForRole(effectiveRole));
      setAdvancedRolesEnabled(Boolean(res.advancedRolesEnabled));
      setEffectiveBreakdown(res.effectiveBreakdown ?? []);
      setServerEffectiveRole(res.effectiveRole ?? effectiveRole);
    } catch (err) {
      setError(formatPermissionError(err, '権限一覧の取得に失敗しました'));
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
    if (!trimmed || !canManage) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(() => {
      searchPrincipals(trimmed)
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
  }, [query, canManage]);

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPrincipal || submitting) return;
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
    if (entry.inherited) return;
    setError(null);
    try {
      await revokePermission(entry.id);
      await reloadPermissions();
    } catch (err) {
      setError(formatPermissionError(err, '権限の削除に失敗しました'));
    }
  }

  return {
    permissions,
    capabilities,
    advancedRolesEnabled,
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
    role,
    setRole,
    submitting,
    canManage,
    handleGrant,
    handleRevoke,
  };
}
