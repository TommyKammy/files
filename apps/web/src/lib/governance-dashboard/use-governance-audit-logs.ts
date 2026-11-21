'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GUEST_AUDIT_ACTION_PREFIXES,
  PERMISSION_AUDIT_ACTION_PREFIXES,
  ROOT_FOLDER_AUDIT_ACTIONS,
  USER_AUDIT_ACTION_PREFIXES,
} from '@/lib/admin-audit';
import {
  ADMIN_AUDIT_PRESETS,
  buildAdminAuditPresetHref,
  parseAdminAuditPreset,
  type AdminConsoleSection,
} from '@/lib/admin-console-nav';
import { hasAdminCapability } from '@/lib/admin-delegations';
import { ApiClientError, fetchAuditLogs } from '@/lib/files-api';
import type { AuditLogEntry, AuthUser } from '@/types/files';

interface UseGovernanceAuditLogsOptions {
  section: AdminConsoleSection;
  auditPreset: string | string[] | null;
  user: AuthUser | null;
  selectTab: (tabId: string) => void;
  setSelectedTabId: (tabId: string | null) => void;
  setError: (message: string | null) => void;
}

/**
 * Manages governance audit log feed state, filter inputs, preset navigation,
 * and keyset cursor pagination.
 */
export function useGovernanceAuditLogs({
  section,
  auditPreset,
  user,
  selectTab,
  setSelectedTabId,
  setError,
}: UseGovernanceAuditLogsOptions) {
  const router = useRouter();

  const initialAuditPreset = parseAdminAuditPreset(auditPreset);
  const initialAuditPresetConfig = initialAuditPreset
    ? ADMIN_AUDIT_PRESETS[initialAuditPreset]
    : null;

  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<{
    createdAt: string;
    id: string;
  } | null>(null);
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditActionPreset, setAuditActionPreset] = useState<string[]>(
    initialAuditPresetConfig ? [...initialAuditPresetConfig.actions] : []
  );
  const [auditActionPrefixFilter, setAuditActionPrefixFilter] = useState('');
  const [auditActionPrefixPreset, setAuditActionPrefixPreset] = useState<
    string[]
  >(
    initialAuditPresetConfig
      ? [...initialAuditPresetConfig.actionPrefixes]
      : []
  );
  const [auditPresetKind, setAuditPresetKind] = useState<
    'permission' | 'guest' | 'user' | 'security' | null
  >(initialAuditPresetConfig?.presetKind ?? null);
  const [auditTargetType, setAuditTargetType] = useState('');
  const [auditStatusFilter, setAuditStatusFilter] = useState<
    '' | 'allowed' | 'blocked'
  >('');
  const [auditActorEmailFilter, setAuditActorEmailFilter] = useState('');
  const [auditTargetIdFilter, setAuditTargetIdFilter] = useState('');
  const [auditFromFilter, setAuditFromFilter] = useState('');
  const [auditToFilter, setAuditToFilter] = useState('');
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  // The reports page is a normal server-rendered route, so `auditPreset`
  // arrives as a prop. Only re-apply when the raw query value changes; the
  // initial state above already covers the first render.
  const initialAuditPresetRaw =
    (Array.isArray(auditPreset) ? auditPreset[0] : auditPreset) ?? null;
  const appliedAuditPresetRef = useRef<string | null>(initialAuditPresetRaw);

  useEffect(() => {
    const raw =
      (Array.isArray(auditPreset) ? auditPreset[0] : auditPreset) ?? null;
    if (appliedAuditPresetRef.current === raw) return;
    appliedAuditPresetRef.current = raw;

    const parsed = parseAdminAuditPreset(raw);
    const config = parsed ? ADMIN_AUDIT_PRESETS[parsed] : null;
    setAuditActionFilter('');
    setAuditActionPrefixFilter('');
    setAuditTargetType('');
    setAuditStatusFilter('');
    setAuditActionPreset(config ? [...config.actions] : []);
    setAuditActionPrefixPreset(config ? [...config.actionPrefixes] : []);
    setAuditPresetKind(config?.presetKind ?? null);
    // `?auditPreset=...` links always land on the audit-logs tab so the
    // preset results are visible at the top of the reports page instead of
    // requiring a scroll to a stacked audit section.
    if (parsed && section === 'reports') {
      setSelectedTabId('audit-logs');
    }
  }, [auditPreset, section, setSelectedTabId]);

  const auditQueryParams = useMemo(
    () => ({
      action: auditActionFilter.trim() || undefined,
      actions: auditActionPreset.length > 0 ? auditActionPreset : undefined,
      actionPrefixes: [
        ...auditActionPrefixPreset,
        ...(auditActionPrefixFilter.trim()
          ? [auditActionPrefixFilter.trim()]
          : []),
      ].filter(Boolean),
      targetType: auditTargetType || undefined,
      status: auditStatusFilter || undefined,
      actorEmail: auditActorEmailFilter.trim() || undefined,
      targetId: auditTargetIdFilter.trim() || undefined,
      from: auditFromFilter || undefined,
      to: auditToFilter || undefined,
      limit: 50,
    }),
    [
      auditActionFilter,
      auditActionPreset,
      auditActionPrefixFilter,
      auditActionPrefixPreset,
      auditTargetType,
      auditStatusFilter,
      auditActorEmailFilter,
      auditTargetIdFilter,
      auditFromFilter,
      auditToFilter,
    ]
  );

  const applyAuditLogsResponse = useCallback(
    (logsRes: {
      logs: AuditLogEntry[];
      nextCursor: { createdAt: string; id: string } | null;
    }) => {
      setAuditLogs(logsRes.logs);
      setAuditCursor(logsRes.nextCursor);
    },
    []
  );

  const clearAuditLogs = useCallback(() => {
    setAuditLogs([]);
  }, []);

  function handleShowRootFolderAudit() {
    if (section !== 'all') {
      router.push(buildAdminAuditPresetHref('rootFolder'));
      return;
    }
    setAuditActionFilter('');
    setAuditActionPreset([...ROOT_FOLDER_AUDIT_ACTIONS]);
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([]);
    setAuditPresetKind(null);
    setAuditTargetType('');
    selectTab('reports');
  }

  function handleShowPermissionAudit() {
    setAuditActionFilter('');
    setAuditActionPreset([]);
    setAuditStatusFilter('');
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([...PERMISSION_AUDIT_ACTION_PREFIXES]);
    setAuditPresetKind('permission');
    setAuditTargetType('');
    // The reports section has a dedicated audit-logs tab; the integrated
    // `/admin` view exposes it inside the reports tab. Switch tabs instead
    // of scrolling to a section that may be stacked below the fold.
    if (section === 'reports') {
      selectTab('audit-logs');
    } else if (section === 'all') {
      selectTab('reports');
    }
  }

  /** Guest lifecycle preset: `guest.*` and `admin.guest.*`. */
  function handleShowGuestAudit() {
    if (section !== 'all') {
      router.push(buildAdminAuditPresetHref('guest'));
      return;
    }
    setAuditActionFilter('');
    setAuditActionPreset([]);
    setAuditStatusFilter('');
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([...GUEST_AUDIT_ACTION_PREFIXES]);
    setAuditPresetKind('guest');
    setAuditTargetType('');
    selectTab('reports');
  }

  /** Internal member administration preset: `admin.user.*`. */
  function handleShowMemberAudit() {
    if (section !== 'all') {
      router.push(buildAdminAuditPresetHref('user'));
      return;
    }
    setAuditActionFilter('');
    setAuditActionPreset([]);
    setAuditStatusFilter('');
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([...USER_AUDIT_ACTION_PREFIXES]);
    setAuditPresetKind('user');
    setAuditTargetType('');
    selectTab('reports');
  }

  function handleClearAuditPreset() {
    setAuditActionPreset([]);
    setAuditPresetKind((current) =>
      current === 'security' ? null : current
    );
  }

  function handleClearAuditPrefixPreset() {
    setAuditActionPrefixPreset([]);
    setAuditPresetKind(null);
  }

  function handleAuditActionFilterChange(value: string) {
    setAuditActionPreset([]);
    setAuditActionPrefixPreset([]);
    setAuditActionPrefixFilter('');
    setAuditPresetKind(null);
    setAuditActionFilter(value);
  }

  function handleAuditActionPrefixFilterChange(value: string) {
    setAuditActionPrefixPreset([]);
    setAuditPresetKind(null);
    setAuditActionPrefixFilter(value);
  }

  function handleAuditTargetTypeChange(value: string) {
    setAuditTargetType(value);
  }

  /**
   * Reset every audit filter (including the new date/actor/target fields) so
   * the CSV link and the next keyset page return to the tenant-wide feed.
   */
  function handleClearAuditFilters() {
    setAuditActionFilter('');
    setAuditActionPreset([]);
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([]);
    setAuditPresetKind(null);
    setAuditTargetType('');
    setAuditStatusFilter('');
    setAuditActorEmailFilter('');
    setAuditTargetIdFilter('');
    setAuditFromFilter('');
    setAuditToFilter('');
  }

  async function handleLoadMoreLogs() {
    if (
      !auditCursor ||
      auditLoadingMore ||
      !hasAdminCapability(user, 'admin.audit.read')
    ) {
      return;
    }
    setAuditLoadingMore(true);
    try {
      const res = await fetchAuditLogs({
        ...auditQueryParams,
        cursorCreatedAt: auditCursor.createdAt,
        cursorId: auditCursor.id,
      });
      setAuditLogs((prev) => [...prev, ...res.logs]);
      setAuditCursor(res.nextCursor);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '監査ログの読み込みに失敗しました'
      );
    } finally {
      setAuditLoadingMore(false);
    }
  }

  return {
    auditLogs,
    auditCursor,
    auditActionFilter,
    auditActionPreset,
    auditActionPrefixFilter,
    auditActionPrefixPreset,
    auditPresetKind,
    auditTargetType,
    auditStatusFilter,
    auditActorEmailFilter,
    auditTargetIdFilter,
    auditFromFilter,
    auditToFilter,
    auditLoadingMore,
    auditQueryParams,
    applyAuditLogsResponse,
    clearAuditLogs,
    setAuditActionFilter: handleAuditActionFilterChange,
    setAuditActionPrefixFilter: handleAuditActionPrefixFilterChange,
    setAuditTargetType: handleAuditTargetTypeChange,
    setAuditStatusFilter,
    setAuditActorEmailFilter,
    setAuditTargetIdFilter,
    setAuditFromFilter,
    setAuditToFilter,
    handleClearAuditFilters,
    handleClearAuditPrefixPreset,
    handleShowPermissionAudit,
    handleShowGuestAudit,
    handleShowMemberAudit,
    handleShowRootFolderAudit,
    handleClearAuditPreset,
    handleLoadMoreLogs,
  };
}
