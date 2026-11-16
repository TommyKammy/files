'use client';

import { useEffect, useState } from 'react';
import {
  ApiClientError,
  grantPermission,
  listPermissions,
  revokePermission,
  searchPrincipals,
} from '@/lib/files-api';
import type {
  PermissionEntry,
  PrincipalCandidate,
  ResourceRole,
} from '@/types/files';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<PrincipalCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPrincipal, setSelectedPrincipal] =
    useState<PrincipalCandidate | null>(null);
  const [role, setRole] = useState<ResourceRole>('viewer');
  const [submitting, setSubmitting] = useState(false);

  const canManage = effectiveRole === 'co_owner' || effectiveRole === 'owner';

  async function reloadPermissions() {
    setLoading(true);
    setError(null);
    try {
      const res = await listPermissions(targetType, targetId);
      setPermissions(res.permissions);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '権限一覧の取得に失敗しました'
      );
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
      setError(
        err instanceof ApiClientError ? err.message : '権限の付与に失敗しました'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(entry: PermissionEntry) {
    setError(null);
    try {
      await revokePermission(entry.id);
      await reloadPermissions();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '権限の削除に失敗しました'
      );
    }
  }

  return {
    permissions,
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
