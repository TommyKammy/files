'use client';

import {
  Activity,
  Download,
  Eye,
  FileText,
  Folder,
  History,
  Info,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Shield,
  Sparkles,
  Tag,
  Unlock,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  InspectorActivityPanel,
  InspectorCommentsPanel,
} from '@/components/InspectorCommentsActivityPanels';
import { canAccess } from '@/lib/capabilities';
import type { InspectorTab } from '@/lib/files-api/comments-activity';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import {
  canUserUnlockFileLock,
  useFileLockActions,
} from '@/lib/use-file-lock-actions';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  BreadcrumbItem,
  Capability,
  FileItem,
  FileLockInfo,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export type InspectorTarget =
  | { kind: 'folder'; folder: FolderSummary }
  | { kind: 'file'; file: FileItem };

export function WorkspaceInspectorDrawer({
  target,
  effectiveRole,
  capabilities,
  breadcrumbs,
  canPreview,
  canDownload,
  canClassify,
  canShare,
  canManageLinks,
  canManagePerms,
  canInvitePerms = false,
  canVersionHistory,
  isPrivilegedAdmin,
  lock,
  currentUserId = null,
  initialTab = 'details',
  syncStore,
  onClose,
  onPreview,
  onDownload,
  onOpenVersionHistory,
  onOpenClassification,
  onOpenShare,
  onOpenPermissions,
  onApproveAi,
  onLockChanged,
}: {
  target: InspectorTarget;
  effectiveRole: ResourceRole;
  capabilities?: Capability[];
  breadcrumbs: BreadcrumbItem[];
  canPreview: boolean;
  canDownload: boolean;
  canClassify: boolean;
  canShare: boolean;
  canManageLinks: boolean;
  canManagePerms: boolean;
  canInvitePerms?: boolean;
  canVersionHistory: boolean;
  isPrivilegedAdmin: boolean;
  lock?: FileLockInfo | null;
  currentUserId?: string | null;
  initialTab?: InspectorTab;
  syncStore: WorkspaceSyncStore;
  onClose: () => void;
  onPreview: (file: FileItem) => void;
  onDownload: (fileId: string) => void;
  onOpenVersionHistory: (
    file: FileItem,
    returnFocus?: HTMLElement | null
  ) => void;
  onOpenClassification: (file: FileItem) => void;
  onOpenShare: (target: InspectorTarget) => void;
  onOpenPermissions: (target: InspectorTarget) => void;
  onApproveAi: (file: FileItem) => void;
  onLockChanged?: (fileId: string, lock: FileLockInfo | null) => void;
}) {
  const isFolder = target.kind === 'folder';
  const item = isFolder ? target.folder : target.file;
  const itemType = isFolder ? 'folder' : 'file';
  const [activeTab, setActiveTab] = useState<InspectorTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, item.id, itemType]);
  const itemRole = isFolder
    ? target.folder.effectiveRole ?? effectiveRole
    : effectiveRole;
  const parentId = isFolder ? target.folder.parent_id : target.file.folder_id;

  // Trace whether confidential classification is inherited from an ancestor folder
  const confidentialAncestor = (() => {
    for (let i = breadcrumbs.length - 1; i >= 0; i -= 1) {
      const crumb = breadcrumbs[i]!;
      if (isFolder && crumb.id === item.id) continue;
      if (crumb.classification === 'confidential') {
        return crumb.name;
      }
    }
    const ancLabels = syncStore.getAncestorClassifications(parentId);
    if (ancLabels.includes('confidential')) {
      return parentId ? '親フォルダ階層' : null;
    }
    return null;
  })();

  const targetAccess = {
    capabilities:
      isFolder ? target.folder.capabilities ?? capabilities : capabilities,
    effectiveRole: itemRole,
  };
  const canCopyItem =
    isPrivilegedAdmin || canAccess(targetAccess, 'item.download');
  const canEditContent =
    isPrivilegedAdmin || canAccess(targetAccess, 'item.edit_content');
  const {
    lock: activeLock,
    busy: lockBusy,
    error: lockError,
    acquireLock,
    releaseLock,
  } = useFileLockActions({
    fileId: isFolder ? null : target.file.id,
    initialLock: lock ?? null,
    syncStore,
    onLockChanged,
  });
  const canUnlock = canUserUnlockFileLock({
    lock: activeLock,
    currentUserId,
    isPrivilegedAdmin,
    canManagePermissions: canManagePerms,
    canEditContent,
  });

  return (
    <aside
      aria-label="詳細インスペクタ"
      className="w-80 shrink-0 border-l border-slate-200 bg-white p-4 space-y-4 overflow-y-auto"
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {isFolder ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
              <Folder className="h-5 w-5" />
            </div>
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <FileText className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-900">
              {item.name}
            </h2>
            <p className="text-[0.6875rem] text-slate-500">
              {isFolder ? 'フォルダ' : target.file.mime_type || 'ファイル'}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="詳細インスペクタを閉じる"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="インスペクタタブ"
        className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 text-xs"
      >
        {(
          [
            { id: 'details', label: '詳細', icon: Info },
            { id: 'comments', label: 'コメント', icon: MessageSquare },
            { id: 'activity', label: 'アクティビティ', icon: Activity },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`inspector-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 font-medium transition-colors ${
                selected
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {activeTab === 'comments' && (
        <InspectorCommentsPanel
          itemType={itemType}
          itemId={item.id}
          currentUserId={currentUserId}
          isPrivilegedAdmin={isPrivilegedAdmin}
        />
      )}

      {activeTab === 'activity' && (
        <InspectorActivityPanel itemType={itemType} itemId={item.id} />
      )}

      {activeTab === 'details' && (
        <>

      {activeLock && (
        <section
          data-testid="inspector-lock-banner"
          className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-800">
              <Lock className="h-3.5 w-3.5" />
              ロック中
            </span>
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-[0.625rem] text-amber-700">
              {activeLock.mode === 'desktop_exclusive' ? '排他ロック' : 'Web WOPI'}
            </span>
          </div>
          <p className="text-[0.6875rem] leading-relaxed text-amber-800">
            {activeLock.ownerName} さんがロック中です。期限:{' '}
            {formatDateTime(new Date(activeLock.expiresAt).toISOString())}
          </p>
          {!isFolder && canUnlock && (
            <button
              type="button"
              data-testid="inspector-unlock-button"
              disabled={lockBusy}
              onClick={() => void releaseLock()}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-[0.6875rem] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              {lockBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Unlock className="h-3.5 w-3.5" />
              )}
              <span>ロックを解除</span>
            </button>
          )}
        </section>
      )}
      {lockError && (
        <div
          role="alert"
          data-testid="inspector-lock-error"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          {lockError}
        </div>
      )}

      <section className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-600">機密区分 & DLP</span>
          <ClassificationBadge classification={item.classification} />
        </div>
        {confidentialAncestor ? (
          <p className="text-[0.6875rem] leading-relaxed text-amber-800">
            親フォルダ「{confidentialAncestor}」から{' '}
            <span className="font-semibold">Confidential (極秘)</span>{' '}
            を継承中（下位ランクへの変更不可）
          </p>
        ) : (
          <p className="text-[0.6875rem] text-slate-500">
            直接設定または親既定値に基づく機密区分
          </p>
        )}

        {!isFolder && target.file.ai_suggested_label && (
          <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/80 p-2.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1 font-semibold text-indigo-800">
                <Sparkles className="h-3.5 w-3.5" />
                <span>AI 分類提案</span>
              </span>
              <ClassificationBadge
                classification={target.file.ai_suggested_label}
                compact
              />
            </div>
            {target.file.ai_confidence != null && (
              <div className="text-[0.6875rem] text-indigo-700">
                確信度: {Math.round(target.file.ai_confidence * 100)}%
              </div>
            )}
            {target.file.ai_reason && (
              <p className="text-[0.6875rem] leading-relaxed text-indigo-900">
                {target.file.ai_reason}
              </p>
            )}
            {(canClassify || isPrivilegedAdmin) && (
              <button
                type="button"
                onClick={() => onApproveAi(target.file)}
                className="w-full rounded-md bg-indigo-600 px-2.5 py-1 text-[0.6875rem] font-semibold text-white hover:bg-indigo-700"
              >
                AI提案を承認する
              </button>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2 text-xs">
        <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
          メタデータ & アクセス権
        </h3>
        <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between px-3 py-2">
            <dt className="text-slate-500">実効ロール</dt>
            <dd className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[0.6875rem] font-medium text-slate-800">
              {itemRole}
            </dd>
          </div>
          <div className="flex items-center justify-between px-3 py-2">
            <dt className="text-slate-500">複製 / ダウンロード</dt>
            <dd className="text-[0.6875rem] font-medium text-slate-700">
              {canCopyItem ? '許可' : '禁止 (Previewer DLP)'}
            </dd>
          </div>
          {!isFolder && (
            <>
              <div className="flex items-center justify-between px-3 py-2">
                <dt className="text-slate-500">サイズ</dt>
                <dd className="font-mono text-slate-700">
                  {formatBytes(target.file.size_bytes)}
                </dd>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <dt className="text-slate-500">バージョン</dt>
                <dd className="font-mono text-slate-700">
                  v{target.file.current_version_num} (meta #{target.file.meta_version ?? 1})
                </dd>
              </div>
            </>
          )}
          {isFolder && (
            <div className="flex items-center justify-between px-3 py-2">
              <dt className="text-slate-500">バージョン</dt>
              <dd className="font-mono text-slate-700">v{target.folder.version}</dd>
            </div>
          )}
          <div className="flex items-center justify-between px-3 py-2">
            <dt className="text-slate-500">最終更新</dt>
            <dd className="text-slate-700">{formatDateTime(item.updated_at)}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-1.5 pt-1 text-xs">
        <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
          クイック操作
        </h3>
        {!isFolder && canPreview && (
          <button
            type="button"
            onClick={() => onPreview(target.file)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Eye className="h-3.5 w-3.5 text-blue-600" />
            <span>プレビュー (Enter / Space)</span>
          </button>
        )}
        {!isFolder && canVersionHistory && (
          <button
            type="button"
            data-testid="inspector-open-version-history"
            onClick={(event) =>
              onOpenVersionHistory(target.file, event.currentTarget)
            }
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <History className="h-3.5 w-3.5 text-indigo-600" />
            <span>版履歴を開く</span>
          </button>
        )}
        {!isFolder && canDownload && (
          <button
            type="button"
            onClick={() => onDownload(target.file.id)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5 text-slate-600" />
            <span>ダウンロード (d)</span>
          </button>
        )}
        {!isFolder && canEditContent && !activeLock && (
          <button
            type="button"
            data-testid="inspector-lock-button"
            disabled={lockBusy}
            onClick={() => void acquireLock()}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {lockBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
            ) : (
              <Lock className="h-3.5 w-3.5 text-amber-600" />
            )}
            <span>ファイルをロック</span>
          </button>
        )}
        {!isFolder && (canClassify || isPrivilegedAdmin) && (
          <button
            type="button"
            onClick={() => onOpenClassification(target.file)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Tag className="h-3.5 w-3.5 text-amber-600" />
            <span>機密区分を変更 (c)</span>
          </button>
        )}
        {canShare && (
          <button
            type="button"
            onClick={() => onOpenShare(target)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Link2 className="h-3.5 w-3.5 text-blue-600" />
            <span>共有リンク設定 (s)</span>
          </button>
        )}
        {canManageLinks && !canShare && (
          <p className="px-1 text-[0.625rem] text-slate-500">
            共有リンクの管理には share_link.manage 権限が必要です。
          </p>
        )}
        {(canManagePerms || canInvitePerms) && (
          <button
            type="button"
            onClick={() => onOpenPermissions(target)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Shield className="h-3.5 w-3.5 text-slate-600" />
            <span>{canManagePerms ? '権限管理' : 'メンバー招待'}</span>
          </button>
        )}
      </section>
        </>
      )}
    </aside>
  );
}
