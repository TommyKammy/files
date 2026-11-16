'use client';

import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AiSuggestionQueue } from '@/components/admin/AiSuggestionQueue';
import { AuditLogSection } from '@/components/admin/AuditLogSection';
import { SharedLinksPolicySection } from '@/components/admin/SharedLinksPolicySection';
import { StorageStatsSection } from '@/components/admin/StorageStatsSection';
import { AppShellRail } from '@/components/AppShellRail';
import { useGovernanceDashboard } from '@/lib/use-governance-dashboard';
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
import { AdminAiBatchCoalescer } from '@/lib/mutation-outbox';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import type {
  AdminSharedLinkRow,
  AiSuggestionItem,
  AuditLogEntry,
  ClassificationLabel,
  StorageStatsResponse,
  TenantPolicyRow,
} from '@/types/files';

export function HybridGovernanceDashboard() {
  const {
    syncStore,
    user,
    authChecked,
    isPrivilegedAdmin,
    loading,
    error,
    notice,
    stats,
    suggestions,
    selectedIds,
    labelFilter,
    bulkBusy,
    sharedLinks,
    policy,
    policySaving,
    auditLogs,
    auditCursor,
    auditActionFilter,
    auditStatusFilter,
    auditLoadingMore,
    setLabelFilter,
    setAuditActionFilter,
    setAuditStatusFilter,
    setPolicy,
    loadAll,
    toggleSelection,
    handleSelectAllSuggestions,
    handleBulkApprove,
    handleSingleApprove,
    handleEmergencyRevoke,
    handlePolicySubmit,
    handleLoadMoreLogs,
  } = useGovernanceDashboard();

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
          <StorageStatsSection stats={stats} usedPct={usedPct} />
        )}

        <AiSuggestionQueue
          suggestions={suggestions}
          selectedIds={selectedIds}
          labelFilter={labelFilter}
          bulkBusy={bulkBusy}
          onFilterChange={setLabelFilter}
          onSelectAll={handleSelectAllSuggestions}
          onBulkApprove={handleBulkApprove}
          onSingleApprove={handleSingleApprove}
          onToggleSelection={toggleSelection}
        />

        <SharedLinksPolicySection
          sharedLinks={sharedLinks}
          policy={policy}
          policySaving={policySaving}
          onEmergencyRevoke={handleEmergencyRevoke}
          onPolicySubmit={handlePolicySubmit}
          onPolicyChange={setPolicy}
        />

        <AuditLogSection
          auditLogs={auditLogs}
          auditCursor={auditCursor}
          auditActionFilter={auditActionFilter}
          auditStatusFilter={auditStatusFilter}
          auditLoadingMore={auditLoadingMore}
          onActionFilterChange={setAuditActionFilter}
          onStatusFilterChange={setAuditStatusFilter}
          onLoadMore={handleLoadMoreLogs}
        />

      </main>
    </div>
  );
}
