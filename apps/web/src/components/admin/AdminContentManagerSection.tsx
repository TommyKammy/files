'use client';

import { AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ADMIN_CONTENT_PAGE_SIZE,
  DEFAULT_ADMIN_CONTENT_FILTERS,
  isAdminContentReasonValid,
  mergeAdminContentSearchItems,
} from '@/lib/admin-content';
import {
  adminEmergencyRevokeSharedLink,
  ApiClientError,
  fetchAdminContentDetail,
  forceUnlockAdminContentFile,
  inspectAdminContentFile,
  searchAdminContent,
} from '@/lib/files-api';
import type {
  AdminContentDetail,
  AdminContentInspectResponse,
  AdminContentSearchFilters,
  AdminContentSearchItem,
} from '@/types/files';
import { ContentInspectorDrawer } from './content-manager/ContentInspectorDrawer';
import { ContentManagerFilterForm } from './content-manager/ContentManagerFilterForm';
import { ContentManagerTable } from './content-manager/ContentManagerTable';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError ? err.message : fallback;
}

/** Tenant-wide ACL-independent content search and inspection section for admins. */
export function AdminContentManagerSection() {
  const [filters, setFilters] = useState<AdminContentSearchFilters>(
    DEFAULT_ADMIN_CONTENT_FILTERS
  );
  const [appliedFilters, setAppliedFilters] =
    useState<AdminContentSearchFilters>(DEFAULT_ADMIN_CONTENT_FILTERS);
  const [items, setItems] = useState<AdminContentSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selected, setSelected] = useState<{
    targetType: 'file' | 'folder';
    id: string;
  } | null>(null);
  const [detail, setDetail] = useState<AdminContentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [unlockReason, setUnlockReason] = useState('');
  const [inspectReason, setInspectReason] = useState('');
  const [actionBusy, setActionBusy] = useState<
    'unlock' | 'inspect' | 'revoke' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [inspectResult, setInspectResult] =
    useState<AdminContentInspectResponse | null>(null);

  const searchRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const loadPage = useCallback(
    async (
      nextFilters: AdminContentSearchFilters,
      cursor: string | null,
      append: boolean
    ) => {
      const requestId = ++searchRequestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await searchAdminContent(
          nextFilters,
          cursor,
          ADMIN_CONTENT_PAGE_SIZE
        );
        if (requestId !== searchRequestRef.current) return;
        setItems((prev) =>
          append ? mergeAdminContentSearchItems(prev, res.items) : res.items
        );
        setNextCursor(res.nextCursor);
      } catch (err) {
        if (requestId !== searchRequestRef.current) return;
        setError(errorMessage(err, 'コンテンツ検索に失敗しました'));
      } finally {
        if (requestId === searchRequestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    void loadPage(DEFAULT_ADMIN_CONTENT_FILTERS, null, false);
  }, [loadPage]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedFilters(filters);
    setNotice(null);
    void loadPage(filters, null, false);
  }

  function handleReset() {
    setFilters(DEFAULT_ADMIN_CONTENT_FILTERS);
    setAppliedFilters(DEFAULT_ADMIN_CONTENT_FILTERS);
    setNotice(null);
    void loadPage(DEFAULT_ADMIN_CONTENT_FILTERS, null, false);
  }

  function openInspector(item: AdminContentSearchItem) {
    const target = { targetType: item.targetType, id: item.id };
    setSelected(target);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setUnlockReason('');
    setInspectReason('');
    setActionBusy(null);
    setActionError(null);
    setActionNotice(null);
    setInspectResult(null);
    const requestId = ++detailRequestRef.current;
    void fetchAdminContentDetail(item.targetType, item.id)
      .then((res) => {
        if (requestId !== detailRequestRef.current) return;
        setDetail(res);
      })
      .catch((err) => {
        if (requestId !== detailRequestRef.current) return;
        setDetailError(
          errorMessage(err, 'コンテンツ詳細の取得に失敗しました')
        );
      })
      .finally(() => {
        if (requestId === detailRequestRef.current) setDetailLoading(false);
      });
  }

  function closeInspector() {
    detailRequestRef.current += 1;
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setInspectResult(null);
    setActionError(null);
    setActionNotice(null);
  }

  async function handleForceUnlock() {
    if (!detail || detail.targetType !== 'file') return;
    if (!isAdminContentReasonValid(unlockReason) || actionBusy) return;
    setActionBusy('unlock');
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await forceUnlockAdminContentFile(
        detail.id,
        unlockReason.trim()
      );
      setDetail((prev) => (prev ? { ...prev, activeLock: null } : prev));
      setItems((prev) =>
        prev.map((item) =>
          item.targetType === 'file' && item.id === detail.id
            ? { ...item, activeLock: null }
            : item
        )
      );
      setUnlockReason('');
      setActionNotice(
        `ロックを強制解除しました（${res.lock?.mode ?? 'lock'} / WOPI セッション失効 ${res.revokedWopiSessionCount} 件）。`
      );
    } catch (err) {
      setActionError(errorMessage(err, 'ロックの強制解除に失敗しました'));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRevokeSharedLink(linkId: string) {
    if (!detail || actionBusy) return;
    setActionBusy('revoke');
    setActionError(null);
    setActionNotice(null);
    try {
      await adminEmergencyRevokeSharedLink(
        linkId,
        '管理者コンテンツマネージャーからの緊急失効'
      );
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              sharedLinks: prev.sharedLinks.filter(
                (link) => link.id !== linkId
              ),
            }
          : prev
      );
      setItems((prev) =>
        prev.map((item) =>
          item.targetType === detail.targetType && item.id === detail.id
            ? {
                ...item,
                activeSharedLinkCount: Math.max(
                  0,
                  item.activeSharedLinkCount - 1
                ),
              }
            : item
        )
      );
      setActionNotice('共有リンクを緊急失効しました。');
    } catch (err) {
      setActionError(errorMessage(err, '共有リンクの失効に失敗しました'));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleInspect() {
    if (!detail || detail.targetType !== 'file') return;
    if (!isAdminContentReasonValid(inspectReason) || actionBusy) return;
    setActionBusy('inspect');
    setActionError(null);
    setActionNotice(null);
    setInspectResult(null);
    try {
      const res = await inspectAdminContentFile(
        detail.id,
        inspectReason.trim()
      );
      setInspectResult(res);
      setActionNotice(
        res.watermarkRequired
          ? '監査付きプレビュー URL を発行しました（透かし必須）。'
          : '監査付きプレビュー URL を発行しました。'
      );
    } catch (err) {
      setActionError(
        errorMessage(err, '監査付きプレビューの発行に失敗しました')
      );
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <section
      data-testid="admin-content-manager"
      aria-labelledby="admin-content-manager-heading"
      className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-[#5e6ad2]" />
            <h2
              id="admin-content-manager-heading"
              className="text-sm font-semibold text-slate-900"
            >
              コンテンツマネージャー
            </h2>
          </div>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
            全アカウントのアクティブなファイル・フォルダを ACL
            非依存で横断検索し、所有者・共有リンク・ロック・監査付きプレビューを確認します。
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
          全社横断
        </span>
      </div>

      <ContentManagerFilterForm
        filters={filters}
        loading={loading}
        onFiltersChange={setFilters}
        onSubmit={handleSubmit}
        onReset={handleReset}
      />

      <div aria-live="assertive" aria-atomic="true" className="min-h-0">
        {error && (
          <div
            role="alert"
            data-testid="admin-content-search-error"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {!error && notice && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}
      </div>

      <ContentManagerTable
        items={items}
        loading={loading}
        loadingMore={loadingMore}
        nextCursor={nextCursor}
        appliedQuery={appliedFilters.query}
        onOpenInspector={openInspector}
        onLoadMore={() => void loadPage(appliedFilters, nextCursor, true)}
      />

      {selected && (
        <ContentInspectorDrawer
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          unlockReason={unlockReason}
          inspectReason={inspectReason}
          actionBusy={actionBusy}
          actionError={actionError}
          actionNotice={actionNotice}
          inspectResult={inspectResult}
          onClose={closeInspector}
          onUnlockReasonChange={setUnlockReason}
          onInspectReasonChange={setInspectReason}
          onForceUnlock={() => void handleForceUnlock()}
          onRevokeSharedLink={(linkId) => void handleRevokeSharedLink(linkId)}
          onInspect={() => void handleInspect()}
        />
      )}
    </section>
  );
}
