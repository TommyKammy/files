'use client';

import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  Loader2,
  Search,
} from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  buildPermissionExportHref,
  formatGranteeStatusLabel,
  formatPermissionRoleLabel,
  formatPermissionSourceLabel,
  isPermissionAuditFilterActive,
} from '@/lib/admin-permission-audit';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminPermissionAuditEntry,
  AdminPermissionAuditQuery,
  AdminPermissionAuditResponse,
  AdminPermissionGranteeStatus,
  AdminPermissionHealth,
  AdminPermissionRootSummary,
  AdminPermissionSortBy,
  AdminPermissionSource,
  AdminPermissionTargetType,
  ResourceRole,
} from '@/types/files';

const FIELD_CLASS =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';
const PAGE_SIZE = 50;
const ROLE_OPTIONS: Array<{ value: ResourceRole; label: string }> = [
  { value: 'owner', label: 'オーナー' },
  { value: 'co_owner', label: '共同所有者' },
  { value: 'editor', label: '編集者' },
  { value: 'viewer_uploader', label: '閲覧 + アップロード' },
  { value: 'previewer_uploader', label: 'プレビュー + アップロード' },
  { value: 'viewer', label: '閲覧者' },
  { value: 'previewer', label: 'プレビュー' },
  { value: 'uploader', label: 'アップロード' },
];

export interface DraftFilters {
  targetType: AdminPermissionTargetType;
  rootFolderId: string;
  role: string;
  source: AdminPermissionSource;
  inheritedFromId: string;
  grantee: string;
  grantedBy: string;
  from: string;
  to: string;
  granteeStatus: AdminPermissionGranteeStatus | '';
  health: AdminPermissionHealth;
}

interface AdminPermissionEntriesPanelProps {
  baseId: string;
  permissionCaptionId: string;
  active: boolean;
  data: AdminPermissionAuditResponse | null;
  loading: boolean;
  query: AdminPermissionAuditQuery;
  draft: DraftFilters;
  roots: AdminPermissionRootSummary[];
  inheritedFromOptions: Array<[string, string]>;
  sortAnnouncement: string;
  onDraftChange: Dispatch<SetStateAction<DraftFilters>>;
  onApplyFilters: () => void;
  onClearFilters: () => void;
  onSort: (sortBy: AdminPermissionSortBy) => void;
  onPageChange: (offset: number) => void;
}

export function AdminPermissionEntriesPanel({
  baseId,
  permissionCaptionId,
  active,
  data,
  loading,
  query,
  draft,
  roots,
  inheritedFromOptions,
  sortAnnouncement,
  onDraftChange,
  onApplyFilters,
  onClearFilters,
  onSort,
  onPageChange,
}: AdminPermissionEntriesPanelProps) {
  const entries = data?.entries ?? [];

  return (
    <div
      id={`${baseId}-permissions-panel`}
      role="tabpanel"
      aria-labelledby={`${baseId}-permissions-tab`}
      hidden={!active}
      className="space-y-4 pt-4"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">対象種別</span>
          <select
            aria-label="権限監査の対象種別"
            value={draft.targetType}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                targetType: event.target.value as AdminPermissionTargetType,
              }))
            }
            className={FIELD_CLASS}
          >
            <option value="all">すべて</option>
            <option value="folder">フォルダ</option>
            <option value="file">ファイル</option>
          </select>
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">ルートフォルダ</span>
          <select
            aria-label="権限監査のルートフォルダ"
            value={draft.rootFolderId}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                rootFolderId: event.target.value,
              }))
            }
            className={FIELD_CLASS}
          >
            <option value="">すべて</option>
            {roots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">ロール</span>
          <select
            aria-label="権限監査のロール"
            value={draft.role}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                role: event.target.value,
              }))
            }
            className={FIELD_CLASS}
          >
            <option value="">すべて</option>
            {ROLE_OPTIONS.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">直接 / 継承</span>
          <select
            aria-label="権限監査の直接継承"
            value={draft.source}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                source: event.target.value as AdminPermissionSource,
              }))
            }
            className={FIELD_CLASS}
          >
            <option value="all">すべて</option>
            <option value="direct">直接付与</option>
            <option value="inherited">継承</option>
          </select>
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">継承元フォルダ</span>
          <select
            aria-label="権限監査の継承元フォルダ"
            value={draft.inheritedFromId}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                inheritedFromId: event.target.value,
              }))
            }
            className={FIELD_CLASS}
          >
            <option value="">すべて</option>
            {inheritedFromOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">付与先検索</span>
          <input
            type="search"
            aria-label="権限監査の付与先検索"
            value={draft.grantee}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                grantee: event.target.value,
              }))
            }
            placeholder="名前・メール・グループ名・ID"
            className={FIELD_CLASS}
          />
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">付与者</span>
          <input
            type="search"
            aria-label="権限監査の付与者"
            value={draft.grantedBy}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                grantedBy: event.target.value,
              }))
            }
            placeholder="ID・メール・表示名"
            className={FIELD_CLASS}
          />
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">付与先の状態</span>
          <select
            aria-label="権限監査の付与先状態"
            value={draft.granteeStatus}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                granteeStatus: event.target
                  .value as DraftFilters['granteeStatus'],
              }))
            }
            className={FIELD_CLASS}
          >
            <option value="">すべて</option>
            <option value="active">有効</option>
            <option value="suspended">停止中</option>
            <option value="deleted">削除済み</option>
          </select>
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">健全性</span>
          <select
            aria-label="権限監査の健全性"
            value={draft.health}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                health: event.target.value as AdminPermissionHealth,
              }))
            }
            className={FIELD_CLASS}
          >
            <option value="all">すべて</option>
            <option value="owner_missing">所有者不在</option>
            <option value="inactive_owner">停止/削除オーナー</option>
          </select>
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">付与日 from</span>
          <input
            type="date"
            aria-label="権限監査の付与日 from"
            value={draft.from}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                from: event.target.value,
              }))
            }
            className={FIELD_CLASS}
          />
        </label>
        <label className="space-y-1 text-[0.6875rem] text-slate-600">
          <span className="block font-medium">付与日 to</span>
          <input
            type="date"
            aria-label="権限監査の付与日 to"
            value={draft.to}
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                to: event.target.value,
              }))
            }
            className={FIELD_CLASS}
          />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={onApplyFilters}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2]"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            フィルタを適用
          </button>
          <button
            type="button"
            onClick={onClearFilters}
            disabled={
              !isPermissionAuditFilterActive(query) &&
              !isPermissionAuditFilterActive({
                ...draft,
                granteeStatus: draft.granteeStatus || null,
              })
            }
            className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            解除
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.6875rem] text-slate-600">
          {data?.totalCount ?? 0} 件中 {entries.length} 件を表示
          {entries.length > 0 && (
            <>
              {' '}
              ({(query.offset ?? 0) + 1}–{(query.offset ?? 0) + entries.length})
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={buildPermissionExportHref(query, 'csv')}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            CSV
          </a>
          <a
            href={buildPermissionExportHref(query, 'json')}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            JSON
          </a>
          <button
            type="button"
            disabled={(query.offset ?? 0) === 0 || loading}
            onClick={() =>
              onPageChange(Math.max(0, (query.offset ?? 0) - PAGE_SIZE))
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            前へ
          </button>
          <button
            type="button"
            disabled={!data?.nextOffset || loading}
            onClick={() =>
              onPageChange(data?.nextOffset ?? query.offset ?? 0)
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            次へ
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div role="status" className="sr-only">
        {sortAnnouncement}
      </div>

      <div
        role="region"
        aria-labelledby={permissionCaptionId}
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-slate-200"
      >
        <table className="w-full min-w-[1180px] text-left text-xs">
          <caption id={permissionCaptionId} className="sr-only">
            テナント権限一覧（対象・付与先・ロール・直接/継承・付与者・日時）
          </caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
            <tr>
              <th
                scope="col"
                aria-sort={
                  (query.sortBy ?? 'createdAt') === 'targetName'
                    ? query.sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
                className="px-2 py-1"
              >
                <button
                  type="button"
                  onClick={() => onSort('targetName')}
                  className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                >
                  対象
                  {(query.sortBy ?? 'createdAt') === 'targetName' &&
                    (query.sortDir === 'asc' ? (
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    ))}
                </button>
              </th>
              <th
                scope="col"
                aria-sort={
                  (query.sortBy ?? 'createdAt') === 'granteeName'
                    ? query.sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
                className="px-2 py-1"
              >
                <button
                  type="button"
                  onClick={() => onSort('granteeName')}
                  className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                >
                  付与先
                  {(query.sortBy ?? 'createdAt') === 'granteeName' &&
                    (query.sortDir === 'asc' ? (
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    ))}
                </button>
              </th>
              <th
                scope="col"
                aria-sort={
                  (query.sortBy ?? 'createdAt') === 'role'
                    ? query.sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
                className="px-2 py-1"
              >
                <button
                  type="button"
                  onClick={() => onSort('role')}
                  className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                >
                  ロール
                  {(query.sortBy ?? 'createdAt') === 'role' &&
                    (query.sortDir === 'asc' ? (
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    ))}
                </button>
              </th>
              <th scope="col" className="px-4 py-2.5">
                直接 / 継承
              </th>
              <th scope="col" className="px-4 py-2.5">
                付与者
              </th>
              <th
                scope="col"
                aria-sort={
                  (query.sortBy ?? 'createdAt') === 'createdAt'
                    ? query.sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
                className="px-2 py-1"
              >
                <button
                  type="button"
                  onClick={() => onSort('createdAt')}
                  className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                >
                  付与日時
                  {(query.sortBy ?? 'createdAt') === 'createdAt' &&
                    (query.sortDir === 'asc' ? (
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    ))}
                </button>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map((entry: AdminPermissionAuditEntry) => (
              <tr
                key={entry.id}
                data-testid="admin-permission-entry-row"
                className="hover:bg-slate-50/70"
              >
                <td className="px-4 py-2.5 align-top">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {entry.targetType === 'folder' ? (
                      <Folder
                        className="h-3.5 w-3.5 text-slate-500"
                        aria-hidden="true"
                      />
                    ) : (
                      <FileText
                        className="h-3.5 w-3.5 text-slate-500"
                        aria-hidden="true"
                      />
                    )}
                    <span className="font-medium text-slate-900">
                      {entry.targetName}
                    </span>
                    <ClassificationBadge
                      classification={entry.classification}
                      compact
                    />
                    {entry.targetDeletedAt && (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[0.625rem] font-semibold text-slate-700">
                        削除/アーカイブ済み
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[0.625rem] text-slate-500">
                    {entry.targetType === 'folder' ? 'フォルダ' : 'ファイル'}
                    {entry.rootFolderName
                      ? ` / ルート: ${entry.rootFolderName}`
                      : ''}
                  </span>
                  {entry.classification === 'confidential' && (
                    <span className="mt-1 inline-flex rounded-full bg-purple-50 px-2 py-0.5 text-[0.625rem] font-semibold text-purple-800">
                      メタデータのみ (DLP)
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 align-top">
                  <span className="block font-medium text-slate-800">
                    {entry.granteeName}
                  </span>
                  {entry.granteeEmail && (
                    <span className="block text-[0.625rem] text-slate-500">
                      {entry.granteeEmail}
                    </span>
                  )}
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] text-slate-600">
                      {entry.granteeType === 'group' ? 'グループ' : 'ユーザー'}
                    </span>
                    {entry.granteeStatus !== 'active' && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[0.625rem] font-semibold text-red-700">
                        {formatGranteeStatusLabel(entry.granteeStatus)}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 align-top">
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[0.625rem] font-semibold text-blue-800">
                    {formatPermissionRoleLabel(entry.role)}
                  </span>
                </td>
                <td className="px-4 py-2.5 align-top">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
                      entry.source === 'direct'
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-indigo-50 text-indigo-700'
                    }`}
                  >
                    {entry.source === 'direct' ? '直接付与' : '継承'}
                  </span>
                  <span className="mt-1 block text-[0.625rem] text-slate-500">
                    {formatPermissionSourceLabel(entry)}
                  </span>
                  {entry.source === 'inherited' && entry.inheritedDepth > 0 && (
                    <span className="block text-[0.625rem] text-slate-400">
                      深さ {entry.inheritedDepth}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 align-top text-[0.6875rem] text-slate-600">
                  <span className="block">
                    {entry.grantedByName ?? entry.grantedBy}
                  </span>
                  {entry.grantedByEmail && (
                    <span className="block text-[0.625rem] text-slate-500">
                      {entry.grantedByEmail}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 align-top whitespace-nowrap text-[0.6875rem] text-slate-600">
                  <time dateTime={entry.createdAt}>
                    {formatAuditDateTime(entry.createdAt)}
                  </time>
                </td>
              </tr>
            ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-[0.6875rem] text-slate-500"
                >
                  条件に一致する権限がありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {loading && (
        <p className="flex items-center gap-1.5 text-[0.6875rem] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          権限一覧を読み込み中...
        </p>
      )}
    </div>
  );
}
