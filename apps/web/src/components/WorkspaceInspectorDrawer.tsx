'use client';

import {
  Download,
  Eye,
  FileText,
  Folder,
  Link2,
  Shield,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  formatBytes,
  formatDateTime,
  hasRoleAtLeast,
} from '@/lib/formatters';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  BreadcrumbItem,
  FileItem,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export type InspectorTarget =
  | { kind: 'folder'; folder: FolderSummary }
  | { kind: 'file'; file: FileItem };

export function WorkspaceInspectorDrawer({
  target,
  effectiveRole,
  breadcrumbs,
  canEdit,
  canDownload,
  canManagePerms,
  isPrivilegedAdmin,
  syncStore,
  onClose,
  onPreview,
  onDownload,
  onOpenClassification,
  onOpenShare,
  onOpenPermissions,
  onApproveAi,
}: {
  target: InspectorTarget;
  effectiveRole: ResourceRole;
  breadcrumbs: BreadcrumbItem[];
  canEdit: boolean;
  canDownload: boolean;
  canManagePerms: boolean;
  isPrivilegedAdmin: boolean;
  syncStore: WorkspaceSyncStore;
  onClose: () => void;
  onPreview: (file: FileItem) => void;
  onDownload: (fileId: string) => void;
  onOpenClassification: (file: FileItem) => void;
  onOpenShare: (target: InspectorTarget) => void;
  onOpenPermissions: (target: InspectorTarget) => void;
  onApproveAi: (file: FileItem) => void;
}) {
  const isFolder = target.kind === 'folder';
  const item = isFolder ? target.folder : target.file;
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

  const canCopyItem = isPrivilegedAdmin || hasRoleAtLeast(itemRole, 'viewer');

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
            {(canEdit || isPrivilegedAdmin) && (
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
        {!isFolder && (
          <button
            type="button"
            onClick={() => onPreview(target.file)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Eye className="h-3.5 w-3.5 text-blue-600" />
            <span>プレビュー (Enter / Space)</span>
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
        {!isFolder && (canEdit || isPrivilegedAdmin) && (
          <button
            type="button"
            onClick={() => onOpenClassification(target.file)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Tag className="h-3.5 w-3.5 text-amber-600" />
            <span>機密区分を変更 (c)</span>
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => onOpenShare(target)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Link2 className="h-3.5 w-3.5 text-blue-600" />
            <span>共有リンク設定 (s)</span>
          </button>
        )}
        {canManagePerms && (
          <button
            type="button"
            onClick={() => onOpenPermissions(target)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Shield className="h-3.5 w-3.5 text-slate-600" />
            <span>権限管理</span>
          </button>
        )}
      </section>
    </aside>
  );
}
