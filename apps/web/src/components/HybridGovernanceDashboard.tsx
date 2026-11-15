'use client';

import {
  AlertTriangle,
  CheckSquare,
  Database,
  Download,
  Loader2,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShellRail } from '@/components/AppShellRail';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { LocalDevQuickLoginPanel, SignInCard } from '@/components/SignInCard';
import {
  adminEmergencyRevokeSharedLink,
  ApiClientError,
  bulkApproveAiSuggestions,
  fetchAdminAiSuggestions,
  fetchAdminPolicies,
  fetchAdminSharedLinks,
  fetchAdminStorageStats,
  fetchAuditLogs,
  updateAdminPolicies,
} from '@/lib/files-api';
import {
  CLASSIFICATION_META,
  formatBytes,
  formatAuditDateTime,
} from '@/lib/formatters';
import { AdminAiBatchCoalescer } from '@/lib/mutation-outbox';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import type {
  AdminSharedLinkRow,
  AiClassificationMode,
  AiSuggestionItem,
  AuditLogEntry,
  ClassificationLabel,
  StorageStatsResponse,
  TenantPolicyRow,
} from '@/types/files';

const CLASS_ORDER: ClassificationLabel[] = [
  'confidential',
  'internal',
  'public',
  'unset',
];

export function HybridGovernanceDashboard() {
  const syncStore = getWorkspaceSyncStore();
  const snapshot = useWorkspaceSyncSnapshot();
  const user = snapshot.user;
  const authChecked = snapshot.authStatus !== 'unknown';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [stats, setStats] = useState<StorageStatsResponse | null>(null);
  const [suggestions, setSuggestions] = useState<AiSuggestionItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState<ClassificationLabel | 'all'>('all');
  const [bulkBusy, setBulkBusy] = useState(false);

  const [sharedLinks, setSharedLinks] = useState<AdminSharedLinkRow[]>([]);
  const [policy, setPolicy] = useState<TenantPolicyRow | null>(null);
  const [policySaving, setPolicySaving] = useState(false);

  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<{
    createdAt: string;
    id: string;
  } | null>(null);
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditStatusFilter, setAuditStatusFilter] = useState<'' | 'allowed' | 'blocked'>('');
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  useEffect(() => {
    void syncStore.hydrateFromScopeHint();
    void syncStore.bootstrap();
  }, [syncStore]);

  useEffect(() => {
    if (snapshot.policy && !policy) {
      setPolicy(snapshot.policy);
    }
  }, [snapshot.policy, policy]);

  const isPrivilegedAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';

  const loadAll = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!authChecked || !user || !isPrivilegedAdmin) return;
      if (!options?.silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const [statsRes, aiRes, linksRes, policyRes, logsRes] = await Promise.all([
          fetchAdminStorageStats(),
          fetchAdminAiSuggestions({
            suggestedLabel: labelFilter === 'all' ? undefined : labelFilter,
            limit: 50,
          }),
          fetchAdminSharedLinks(50),
          fetchAdminPolicies(),
          fetchAuditLogs({
            action: auditActionFilter.trim() || undefined,
            status: auditStatusFilter || undefined,
            limit: 50,
          }),
        ]);
        setStats(statsRes);
        setSuggestions(aiRes.suggestions);
        setSelectedIds(new Set());
        setSharedLinks(linksRes.links);
        setPolicy(policyRes.policy);
        setAuditLogs(logsRes.logs);
        setAuditCursor(logsRes.nextCursor);
      } catch (err) {
        if (!options?.silent) {
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'ガバナンスデータの読み込みに失敗しました'
          );
        }
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [
      authChecked,
      user,
      isPrivilegedAdmin,
      labelFilter,
      auditActionFilter,
      auditStatusFilter,
    ]
  );

  useEffect(() => {
    if (authChecked && isPrivilegedAdmin) {
      loadAll();
    } else if (authChecked) {
      setLoading(false);
    }
  }, [authChecked, isPrivilegedAdmin, loadAll]);

  useEffect(() => {
    if (!authChecked || !isPrivilegedAdmin) return;
    let refreshTimer: number | null = null;
    const unlistenSignals = syncStore.subscribeRealtimeSignals(() => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadAll({ silent: true });
      }, 250);
    });
    const unlistenRevocations = syncStore.subscribeSecurityRevocations((event) => {
      if (event.kind === 'user.suspended') {
        setStats(null);
        setSuggestions([]);
        setSharedLinks([]);
        setAuditLogs([]);
        setSelectedIds(new Set());
        setError(
          'アカウント停止またはセッション失効のため管理ダッシュボードデータを消去しました。'
        );
      }
    });
    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      unlistenSignals();
      unlistenRevocations();
    };
  }, [authChecked, isPrivilegedAdmin, loadAll, syncStore]);

  const aiRollbackRef = useRef(
    new Map<string, { item: AiSuggestionItem; index: number }>()
  );

  const aiCoalescer = useMemo(
    () =>
      new AdminAiBatchCoalescer({
        submit: async (batch) => {
          const res = await bulkApproveAiSuggestions(batch);
          for (const item of batch) {
            aiRollbackRef.current.delete(item.fileId);
          }
          setNotice(`${res.approvedCount}件のAI分類提案を承認しました。`);
          void syncStore.syncDelta();
        },
        onError: (batch, err) => {
          setSuggestions((prev) => {
            const next = [...prev];
            for (const b of batch) {
              const snap = aiRollbackRef.current.get(b.fileId);
              if (snap && !next.some((s) => s.fileId === b.fileId)) {
                next.splice(Math.min(snap.index, next.length), 0, snap.item);
              }
              aiRollbackRef.current.delete(b.fileId);
            }
            return next;
          });
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'AI分類承認に失敗したためロールバックしました'
          );
        },
      }),
    [syncStore]
  );

  useEffect(() => () => aiCoalescer.clear(), [aiCoalescer]);

  function toggleSelection(fileId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function handleBulkApprove() {
    if (selectedIds.size === 0 || bulkBusy) return;
    setError(null);
    setNotice(null);

    const targetIds = new Set([...selectedIds].slice(0, 50));
    const items = [...targetIds].map((fileId) => ({ fileId }));
    suggestions.forEach((item, index) => {
      if (targetIds.has(item.fileId)) {
        aiRollbackRef.current.set(item.fileId, { item, index });
      }
    });

    setSuggestions((prev) => prev.filter((s) => !targetIds.has(s.fileId)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) next.delete(id);
      return next;
    });
    setNotice(`${items.length}件のAI分類提案を承認しました（同期中）`);
    aiCoalescer.enqueue(items);
  }

  function handleSingleApprove(
    fileId: string,
    overrideLabel?: Exclude<ClassificationLabel, 'unset'>
  ) {
    setError(null);
    setNotice(null);
    const index = suggestions.findIndex((s) => s.fileId === fileId);
    if (index >= 0) {
      aiRollbackRef.current.set(fileId, { item: suggestions[index], index });
    }
    setSuggestions((prev) => prev.filter((s) => s.fileId !== fileId));
    setSelectedIds((prev) => {
      if (!prev.has(fileId)) return prev;
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
    setNotice('1件のファイル分類を確定しました（同期中）');
    aiCoalescer.enqueue([
      overrideLabel ? { fileId, label: overrideLabel } : { fileId },
    ]);
  }

  async function handleEmergencyRevoke(linkId: string) {
    setError(null);
    setNotice(null);
    const index = sharedLinks.findIndex((l) => l.id === linkId);
    const snapshot = index >= 0 ? sharedLinks[index] : null;

    setSharedLinks((prev) => prev.filter((l) => l.id !== linkId));
    setNotice(`共有リンク (${linkId.slice(0, 8)}...) を緊急失効しました。`);

    try {
      await adminEmergencyRevokeSharedLink(linkId, 'Admin dashboard revocation');
      void syncStore.syncDelta();
    } catch (err) {
      if (snapshot) {
        setSharedLinks((prev) => {
          if (prev.some((l) => l.id === linkId)) return prev;
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, snapshot);
          return next;
        });
      }
      setNotice(null);
      setError(
        err instanceof ApiClientError
          ? err.message
          : '共有リンクの緊急失効に失敗しました'
      );
    }
  }

  async function handlePolicySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!policy || policySaving) return;
    setPolicySaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await updateAdminPolicies({
        enforceCompanyOnlyLinks: policy.enforce_company_only_links === 1,
        requireWatermarkConfidential: policy.require_watermark_confidential === 1,
        maxLinkExpirationDays: policy.max_link_expiration_days,
        sessionMaxHours: policy.session_max_hours,
        trashRetentionDays: policy.trash_retention_days,
        aiClassificationMode: policy.ai_classification_mode,
        aiAutoApplyThreshold: policy.ai_auto_apply_threshold,
      });
      setPolicy(res.policy);
      void syncStore.bootstrap({ force: true });
      setNotice('テナントガバナンスポリシーを更新しました。');
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'ポリシー更新に失敗しました'
      );
    } finally {
      setPolicySaving(false);
    }
  }

  async function handleLoadMoreLogs() {
    if (!auditCursor || auditLoadingMore) return;
    setAuditLoadingMore(true);
    try {
      const res = await fetchAuditLogs({
        action: auditActionFilter.trim() || undefined,
        status: auditStatusFilter || undefined,
        cursorCreatedAt: auditCursor.createdAt,
        cursorId: auditCursor.id,
        limit: 50,
      });
      setAuditLogs((prev) => [...prev, ...res.logs]);
      setAuditCursor(res.nextCursor);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '監査ログの読み込みに失敗しました'
      );
    } finally {
      setAuditLoadingMore(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
        認証を確認中...
      </div>
    );
  }

  if (!user) {
    return (
      <SignInCard
        title="ガバナンスセンターへサインイン"
        description="システム管理者 (sys_admin) またはセキュリティ管理者 (sec_admin) としてサインインしてください。"
        returnTo="/admin"
        preferredRoles={['sys_admin', 'sec_admin']}
        onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
      />
    );
  }

  if (!isPrivilegedAdmin) {
    return (
      <div className="flex min-h-screen bg-[#efeff1] text-slate-900">
        <AppShellRail user={user} activeView="workspace" />
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-xs space-y-3">
            <ShieldAlert className="mx-auto h-8 w-8 text-amber-500" />
            <h1 className="text-base font-semibold text-slate-900">
              アクセス権限がありません (403)
            </h1>
            <p className="text-[0.6875rem] text-[#55565a]">
              管理ガバナンスコンソールは sys_admin または sec_admin ロール専用です。
            </p>
            <Link
              href="/workspace"
              className="inline-flex rounded-md bg-[#5e6ad2] px-4 py-2 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2]"
            >
              ワークスペースに戻る
            </Link>
            <LocalDevQuickLoginPanel
              preferredRoles={['sys_admin', 'sec_admin']}
              onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
            />
          </div>
        </main>
      </div>
    );
  }

  const csvQuery = new URLSearchParams({ format: 'csv', limit: '200' });
  if (auditActionFilter.trim()) csvQuery.set('action', auditActionFilter.trim());
  if (auditStatusFilter) csvQuery.set('status', auditStatusFilter);

  const usedPct =
    stats && stats.quotaBytes > 0
      ? Math.min(100, Math.round((stats.usedBytes / stats.quotaBytes) * 100))
      : 0;

  return (
    <div className="flex min-h-screen bg-[#efeff1] text-slate-900">
      <a
        href="#governance-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#111214] focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]"
      >
        メインコンテンツへスキップ
      </a>
      <AppShellRail user={user} activeView="admin" />

      <main
        id="governance-main"
        tabIndex={-1}
        className="mb-2 mr-2 mt-2 min-w-0 flex-1 space-y-5 rounded-2xl border border-[#e7e7ea] bg-[#f9f9fa] px-5 py-4 lg:px-7"
      >
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-[1rem] font-semibold tracking-[-0.01em] text-[#111214]">
              ガバナンス & セキュリティ統合ダッシュボード
            </h1>
            <p className="text-[0.6875rem] text-[#55565a]">
              D1 O(1) 統計・Workers AI 分類レビュー・緊急失効・不変監査ログ
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>再読み込み</span>
          </button>
        </header>

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800"
          >
            {notice}
          </div>
        )}

        {stats && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 rounded-lg border border-[#e7e7ea] bg-white p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    ストレージ使用量 & 機密分類内訳
                  </h2>
                  <p className="text-[0.6875rem] text-[#55565a]">
                    {formatBytes(stats.usedBytes)} / {formatBytes(stats.quotaBytes)} ({usedPct}%) • 合計 {stats.totalFiles} ファイル
                  </p>
                </div>
              </div>

              <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
                {CLASS_ORDER.map((label) => {
                  const item = stats.byClassification[label];
                  const widthPct =
                    stats.usedBytes > 0
                      ? (item.totalBytes / stats.usedBytes) * 100
                      : 0;
                  if (widthPct <= 0) return null;
                  return (
                    <div
                      key={label}
                      className={CLASSIFICATION_META[label].barClass}
                      style={{ width: `${widthPct}%` }}
                      title={`${CLASSIFICATION_META[label].label}: ${formatBytes(item.totalBytes)} (${item.fileCount} files)`}
                    />
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {CLASS_ORDER.map((label) => {
                  const item = stats.byClassification[label];
                  return (
                    <div
                      key={label}
                      className="rounded-xl border border-slate-100 bg-slate-50/70 p-3"
                    >
                      <ClassificationBadge classification={label} compact />
                      <div className="mt-2 font-mono text-sm font-semibold text-slate-900">
                        {formatBytes(item.totalBytes)}
                      </div>
                      <div className="text-[0.6875rem] text-slate-500">
                        {item.fileCount} ファイル
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-[#e7e7ea] bg-white p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Database className="h-4 w-4 text-indigo-600" />
                  <span>D1 メタデータ DB サイズ監視</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  SQLite pragma_page_count × page_size による推定容量
                </p>
              </div>
              <div className="my-4">
                <div className="font-mono text-2xl font-bold text-slate-900">
                  {stats.d1EstimatedBytes !== null
                    ? formatBytes(stats.d1EstimatedBytes)
                    : '取得不可'}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  残りクォータ: {formatBytes(stats.remainingBytes)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-600">
                集計は tenant_storage_stats から O(1) で取得しています（全件スキャンなし）
              </div>
            </div>
          </section>
        )}

        {/* AI Suggestion Approval Queue */}
        <section className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600" />
              <h2 className="text-sm font-semibold text-slate-900">
                AI 機密分類 提案レビューキュー ({suggestions.length})
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                id="ai-label-filter"
                name="labelFilter"
                aria-label="AI 提案の機密区分で絞り込む"
                value={labelFilter}
                onChange={(e) =>
                  setLabelFilter(e.target.value as ClassificationLabel | 'all')
                }
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
              >
                <option value="all">すべての AI 提案</option>
                <option value="confidential">Confidential 提案のみ</option>
                <option value="internal">Internal 提案のみ</option>
                <option value="public">Public 提案のみ</option>
              </select>

              <button
                type="button"
                disabled={selectedIds.size === 0 || bulkBusy}
                onClick={handleBulkApprove}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {bulkBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckSquare className="h-3.5 w-3.5" />
                )}
                <span>選択 {selectedIds.size}件を一括承認</span>
              </button>
            </div>
          </div>

          {suggestions.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-slate-500">
              承認待ちの AI 分類提案はありません
            </div>
          ) : (
            <div
              role="region"
              aria-label="AI 機密分類の提案レビューキュー"
              tabIndex={0}
              className="overflow-x-auto"
            >
              <table className="w-full text-left text-xs">
                <caption className="sr-only">AI 機密分類の提案レビューキュー</caption>
                <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
                  <tr>
                    <th scope="col" className="w-10 px-4 py-2.5">
                      <label
                        htmlFor="ai-suggestion-select-all"
                        className="flex h-6 w-6 items-center justify-center"
                      >
                        <input
                          id="ai-suggestion-select-all"
                          name="selectAllSuggestions"
                          aria-label="すべての AI 提案を選択"
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-[#5e6ad2]"
                          checked={
                            suggestions.length > 0 &&
                            selectedIds.size === suggestions.length
                          }
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedIds(
                                new Set(suggestions.slice(0, 50).map((s) => s.fileId))
                              );
                            } else {
                              setSelectedIds(new Set());
                            }
                          }}
                        />
                      </label>
                    </th>
                    <th scope="col" className="px-4 py-2.5">ファイル</th>
                    <th scope="col" className="px-4 py-2.5">現在</th>
                    <th scope="col" className="px-4 py-2.5">AI 提案 & 信頼度</th>
                    <th scope="col" className="px-4 py-2.5">推論理由</th>
                    <th scope="col" className="px-4 py-2.5 text-right">承認</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {suggestions.map((item) => (
                    <tr key={item.fileId} className="hover:bg-slate-50/70">
                      <td className="px-4 py-2.5">
                        <label
                          htmlFor={`ai-suggestion-${item.fileId}`}
                          className="flex h-6 w-6 items-center justify-center"
                        >
                          <input
                            id={`ai-suggestion-${item.fileId}`}
                            name="selectedSuggestion"
                            aria-label={`${item.name} を選択`}
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-[#5e6ad2]"
                            checked={selectedIds.has(item.fileId)}
                            onChange={() => toggleSelection(item.fileId)}
                          />
                        </label>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">{item.name}</div>
                        <div className="text-[0.6875rem] text-slate-500">
                          {item.folderName ?? 'Root'} • {item.uploaderEmail ?? '—'}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <ClassificationBadge
                          classification={item.currentClassification}
                          compact
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <ClassificationBadge
                            classification={item.suggestedLabel}
                            compact
                          />
                          {typeof item.confidence === 'number' && (
                            <span className="font-mono text-[0.6875rem] text-slate-600">
                              {Math.round(item.confidence * 100)}%
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="max-w-xs truncate px-4 py-2.5 text-slate-600" title={item.reason ?? ''}>
                        {item.reason ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right space-x-1">
                        <button
                          type="button"
                          onClick={() => handleSingleApprove(item.fileId)}
                          className="rounded-md bg-indigo-50 px-2.5 py-1 text-[0.6875rem] font-semibold text-indigo-700 hover:bg-indigo-100"
                        >
                          提案通り承認
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Active Shared Links + Policies */}
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="xl:col-span-2 overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="text-sm font-semibold text-slate-900">
                稼働中の外部・内部共有リンク監視 ({sharedLinks.length})
              </h2>
            </div>

            {sharedLinks.length === 0 ? (
              <div className="px-5 py-10 text-center text-xs text-slate-500">
                稼働中の共有リンクはありません
              </div>
            ) : (
              <div
                role="region"
                aria-label="稼働中の共有リンク監視"
                tabIndex={0}
                className="overflow-x-auto"
              >
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">稼働中の共有リンク監視</caption>
                  <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
                    <tr>
                      <th scope="col" className="px-4 py-2.5">対象 / 発行者</th>
                      <th scope="col" className="px-4 py-2.5">スコープ / 状態</th>
                      <th scope="col" className="px-4 py-2.5">失敗試行 / DL数</th>
                      <th scope="col" className="px-4 py-2.5 text-right">緊急失効</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sharedLinks.map((link) => {
                      const hasAnomaly =
                        link.failed_password_attempts > 0 || Boolean(link.locked_until);
                      return (
                        <tr
                          key={link.id}
                          className={hasAnomaly ? 'bg-red-50/60' : 'hover:bg-slate-50/70'}
                        >
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-slate-900">
                              {link.target_name ?? link.target_id}
                            </div>
                            <div className="text-[0.6875rem] text-slate-500">
                              {link.target_type} • {link.creator_email ?? link.created_by}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[0.6875rem] text-slate-700">
                              {link.access_scope}
                            </span>
                            {link.locked_until && (
                              <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[0.625rem] font-semibold text-red-700">
                                LOCKED
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[0.6875rem] text-slate-600">
                            PW失敗: {link.failed_password_attempts} • DL:{' '}
                            {link.download_count}
                            {link.max_downloads ? `/${link.max_downloads}` : ''}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              type="button"
                              onClick={() => handleEmergencyRevoke(link.id)}
                              className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[0.6875rem] font-semibold text-red-600 hover:bg-red-50"
                            >
                              緊急失効
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {policy && (
            <form
              onSubmit={handlePolicySubmit}
              className="rounded-lg border border-[#e7e7ea] bg-white p-5 space-y-4"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <SlidersHorizontal className="h-4 w-4 text-slate-600" />
                <span>テナントセキュリティポリシー</span>
              </div>

              <label className="flex items-center justify-between gap-3 text-xs">
                <span className="text-slate-700">共有リンクを社内SSO限定に強制</span>
                <input
                  id="policy-enforce-company-only"
                  name="enforceCompanyOnlyLinks"
                  type="checkbox"
                  checked={policy.enforce_company_only_links === 1}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      enforce_company_only_links: e.target.checked ? 1 : 0,
                    })
                  }
                />
              </label>

              <label className="flex items-center justify-between gap-3 text-xs">
                <span className="text-slate-700">Confidential に動的透かしを強制</span>
                <input
                  id="policy-require-watermark"
                  name="requireWatermarkConfidential"
                  type="checkbox"
                  checked={policy.require_watermark_confidential === 1}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      require_watermark_confidential: e.target.checked ? 1 : 0,
                    })
                  }
                />
              </label>

              <label className="block text-xs">
                <span className="font-medium text-slate-700">
                  AI 分類モード
                </span>
                <select
                  id="policy-ai-classification-mode"
                  name="aiClassificationMode"
                  value={policy.ai_classification_mode}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      ai_classification_mode: e.target.value as AiClassificationMode,
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                >
                  <option value="content_excerpt">content_excerpt (本文先頭抽出)</option>
                  <option value="metadata_only">metadata_only (メタデータのみ)</option>
                  <option value="disabled">disabled (停止)</option>
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="font-medium text-slate-700">最大共有期限 (日)</span>
                  <input
                    id="policy-max-link-expiration-days"
                    name="maxLinkExpirationDays"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    value={policy.max_link_expiration_days}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        max_link_expiration_days: Number.parseInt(
                          e.target.value || '30',
                          10
                        ),
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                  />
                </label>

                <label className="block text-xs">
                  <span className="font-medium text-slate-700">ゴミ箱保持 (日)</span>
                  <input
                    id="policy-trash-retention-days"
                    name="trashRetentionDays"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={3650}
                    value={policy.trash_retention_days}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        trash_retention_days: Number.parseInt(
                          e.target.value || '90',
                          10
                        ),
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                  />
                </label>
              </div>

              <button
                type="submit"
                disabled={policySaving}
                className="h-8 w-full rounded-md bg-[#5e6ad2] text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {policySaving ? '保存中...' : 'ポリシーを保存'}
              </button>
            </form>
          )}
        </section>

        {/* Keyset Audit Log Stream + CSV Export */}
        <section className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">
              不変監査ログ (Audit Logs — Keyset Pagination)
            </h2>

            <div className="flex flex-wrap items-center gap-2">
              <input
                id="audit-action-filter"
                name="auditActionFilter"
                aria-label="監査ログのアクションで絞り込む"
                autoComplete="off"
                spellCheck={false}
                type="text"
                value={auditActionFilter}
                onChange={(e) => setAuditActionFilter(e.target.value)}
                placeholder="action (例: shared_link.create)"
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
              <select
                id="audit-status-filter"
                name="auditStatusFilter"
                aria-label="監査ログの結果で絞り込む"
                value={auditStatusFilter}
                onChange={(e) =>
                  setAuditStatusFilter(
                    e.target.value as '' | 'allowed' | 'blocked'
                  )
                }
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              >
                <option value="">すべての結果</option>
                <option value="allowed">allowed のみ</option>
                <option value="blocked">blocked のみ</option>
              </select>
              <a
                href={`/api/audit-logs?${csvQuery.toString()}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" />
                <span>CSV 出力</span>
              </a>
            </div>
          </div>

          <div
            role="region"
            aria-label="不変監査ログ"
            tabIndex={0}
            className="overflow-x-auto"
          >
            <table className="w-full text-left text-xs">
              <caption className="sr-only">不変監査ログ</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2.5">
                    日時 (JST)
                  </th>
                  <th scope="col" className="px-4 py-2.5">アクション</th>
                  <th scope="col" className="px-4 py-2.5">ステータス</th>
                  <th scope="col" className="px-4 py-2.5">操作者 / IP</th>
                  <th scope="col" className="px-4 py-2.5">対象</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/70">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[0.6875rem] text-slate-600">
                      <time dateTime={log.createdAt}>
                        {formatAuditDateTime(log.createdAt)}
                      </time>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[0.6875rem] font-medium text-slate-900">
                      {log.action}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
                          log.status === 'blocked'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[0.6875rem] text-slate-600">
                      {log.actorEmail ?? 'anonymous'} ({log.actorIp ?? '—'})
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[0.6875rem] text-slate-500">
                      {log.targetType ?? '—'}: {log.targetId?.slice(0, 12) ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {auditCursor && (
            <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center">
              <button
                type="button"
                disabled={auditLoadingMore}
                onClick={handleLoadMoreLogs}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {auditLoadingMore && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                <span>ログをさらに読み込む</span>
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
