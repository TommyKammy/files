'use client';

import { Archive, ArchiveRestore, Loader2, UserCog, Users } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import { PrincipalPicker } from '@/components/admin/permission-audit/AdminPermissionPrincipalPicker';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import {
  createBulkIdempotencyKey,
  formatAdminBulkSummary,
} from '@/lib/admin-permission-audit';
import {
  ApiClientError,
  bulkArchiveAdminRootFolders,
  bulkGrantAdminRootFolderCoOwners,
  bulkRestoreAdminRootFolders,
  bulkTransferAdminRootFolderOwners,
} from '@/lib/files-api';
import type { AdminBulkResponse, PrincipalCandidate } from '@/types/files';

export type BulkAction = 'coowner' | 'transfer' | 'archive' | 'restore';

const FIELD_CLASS =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'skipped':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    default:
      return 'bg-red-50 text-red-700 border-red-200';
  }
}

function BulkResultTable({
  response,
  captionId,
}: {
  response: AdminBulkResponse;
  captionId: string;
}) {
  return (
    <div className="space-y-2">
      <p
        role={response.dryRun ? undefined : 'status'}
        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-700"
      >
        {formatAdminBulkSummary(response.summary)}
        {response.replayed ? '（保存済みの実行結果を再生しました）' : ''}
      </p>
      <div
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-lg border border-slate-200"
      >
        <table className="w-full min-w-[520px] text-left text-[0.6875rem]">
          <caption id={captionId} className="sr-only">
            一括操作の対象フォルダ別結果
          </caption>
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th scope="col" className="px-2.5 py-2">
                フォルダ
              </th>
              <th scope="col" className="px-2.5 py-2">
                状態
              </th>
              <th scope="col" className="px-2.5 py-2">
                理由 / 結果
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {response.results.map((item) => (
              <tr key={item.folderId} data-testid="admin-bulk-result-row">
                <td className="px-2.5 py-2">
                  <span className="block font-medium text-slate-800">
                    {item.folderName || '(名称不明)'}
                  </span>
                  <span className="block font-mono text-[0.625rem] text-slate-500">
                    {item.folderId}
                  </span>
                </td>
                <td className="px-2.5 py-2">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${statusBadgeClass(item.status)}`}
                  >
                    {item.status}
                  </span>
                  {item.code && (
                    <span className="mt-1 block font-mono text-[0.625rem] text-slate-500">
                      {item.code}
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-2 text-slate-600">
                  {item.message ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AdminPermissionBulkModalProps {
  action: BulkAction;
  folderIds: string[];
  onClose: () => void;
  onExecuted: (notice: string) => Promise<void> | void;
}

export function AdminPermissionBulkModal({
  action,
  folderIds,
  onClose,
  onExecuted,
}: AdminPermissionBulkModalProps) {
  const baseId = useId();
  const [modalPreview, setModalPreview] = useState<AdminBulkResponse | null>(
    null
  );
  const [modalResult, setModalResult] = useState<AdminBulkResponse | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const busyRef = useRef(false);
  const [coOwnerGroups, setCoOwnerGroups] = useState<PrincipalCandidate[]>([]);
  const [transferOwner, setTransferOwner] = useState<PrincipalCandidate[]>([]);
  const [demotePreviousOwnersTo, setDemotePreviousOwnersTo] = useState<
    'co_owner' | 'editor' | 'revoke'
  >('co_owner');
  const [idempotencyKey] = useState(() => createBulkIdempotencyKey(action));

  const callBulk = useCallback(
    async (
      groups: PrincipalCandidate[],
      dryRun: boolean
    ): Promise<AdminBulkResponse> => {
      const base = {
        folderIds,
        dryRun,
        ...(dryRun ? {} : { idempotencyKey }),
      };
      if (action === 'coowner') {
        return bulkGrantAdminRootFolderCoOwners({
          ...base,
          groupIds: groups
            .filter((principal) => principal.type === 'group')
            .map((principal) => principal.id),
        });
      }
      if (action === 'transfer') {
        return bulkTransferAdminRootFolderOwners({
          ...base,
          newOwnerUserId: transferOwner[0]?.id ?? '',
          demotePreviousOwnersTo,
        });
      }
      if (action === 'archive') {
        return bulkArchiveAdminRootFolders(base);
      }
      return bulkRestoreAdminRootFolders(base);
    },
    [action, demotePreviousOwnersTo, folderIds, idempotencyKey, transferOwner]
  );

  const previewBulk = useCallback(
    async (groups: PrincipalCandidate[]) => {
      if (busyRef.current) return;
      if (action === 'coowner' && groups.length === 0) {
        setModalError('SCIM グループを1つ以上選択してください');
        return;
      }
      if (action === 'transfer' && !transferOwner[0]) {
        setModalError('新しい所有者を選択してください');
        return;
      }
      busyRef.current = true;
      setModalBusy(true);
      setModalError(null);
      try {
        const response = await callBulk(groups, true);
        setModalPreview(response);
      } catch (err) {
        setModalError(
          err instanceof ApiClientError
            ? err.message
            : '影響プレビューの取得に失敗しました'
        );
      } finally {
        busyRef.current = false;
        setModalBusy(false);
      }
    },
    [action, callBulk, transferOwner]
  );

  useEffect(() => {
    if (action === 'archive' || action === 'restore') {
      void previewBulk([]);
    }
  }, [action, previewBulk]);

  function closeModal() {
    if (busyRef.current) return;
    onClose();
  }

  async function executeBulk() {
    if (!modalPreview || busyRef.current) return;
    busyRef.current = true;
    setModalBusy(true);
    setModalError(null);
    try {
      const response = await callBulk(coOwnerGroups, false);
      setModalResult(response);
      await onExecuted(
        `${response.summary.succeeded}件成功 / ${response.summary.skipped}件スキップ / ${response.summary.failed}件失敗`
      );
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : '一括操作の実行に失敗しました'
      );
    } finally {
      busyRef.current = false;
      setModalBusy(false);
    }
  }

  const modalTitle =
    action === 'coowner'
      ? 'グループ共同所有者一括付与'
      : action === 'transfer'
        ? '所有者一括移管'
        : action === 'archive'
          ? 'ルートフォルダ一括アーカイブ'
          : 'ルートフォルダ一括復元';

  return (
    <ModalShell
      label={modalTitle}
      onClose={closeModal}
      className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <ModalHeader
        icon={
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            {action === 'coowner' ? (
              <Users className="h-4 w-4" />
            ) : action === 'transfer' ? (
              <UserCog className="h-4 w-4" />
            ) : action === 'archive' ? (
              <Archive className="h-4 w-4" />
            ) : (
              <ArchiveRestore className="h-4 w-4" />
            )}
          </span>
        }
        title={modalTitle}
        subtitle={`対象 ${folderIds.length} 件。プレビューを確認してから実行します。`}
        onClose={closeModal}
      />
      <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4 text-xs">
        <ModalError message={modalError} />
        {action === 'coowner' && (
          <PrincipalPicker
            label="SCIM グループ"
            description="選択したすべてのルートフォルダに co_owner として一括付与します。既存の owner は降格されません。"
            inputId={`${baseId}-bulk-group-search`}
            allowGroups
            selected={coOwnerGroups}
            onChange={setCoOwnerGroups}
          />
        )}
        {action === 'transfer' && (
          <>
            <PrincipalPicker
              label="新しい所有者"
              description="テナント内のアクティブユーザーを1名選択します。"
              inputId={`${baseId}-bulk-transfer-owner-search`}
              allowGroups={false}
              single
              selected={transferOwner}
              onChange={setTransferOwner}
            />
            <label className="block space-y-1 text-xs font-medium text-slate-700">
              <span>以前の所有者の扱い</span>
              <select
                aria-label="以前の所有者の扱い"
                value={demotePreviousOwnersTo}
                onChange={(event) =>
                  setDemotePreviousOwnersTo(
                    event.target.value as 'co_owner' | 'editor' | 'revoke'
                  )
                }
                className={FIELD_CLASS}
              >
                <option value="co_owner">共同所有者へ降格</option>
                <option value="editor">編集者へ降格</option>
                <option value="revoke">権限を削除</option>
              </select>
            </label>
          </>
        )}
        {(action === 'archive' || action === 'restore') && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900">
            {action === 'archive'
              ? '配下のフォルダ・ファイルもまとめてアーカイブされます。ファイルロックがある場合は失敗します。'
              : 'アーカイブ済みの配下フォルダ・ファイルもまとめて復元されます。'}
          </p>
        )}

        {!modalPreview && !modalResult && (
          <button
            type="button"
            disabled={modalBusy}
            onClick={() => void previewBulk(coOwnerGroups)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            {modalBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            影響をプレビュー
          </button>
        )}

        {modalPreview && !modalResult && (
          <BulkResultTable
            response={modalPreview}
            captionId={`${baseId}-bulk-preview-caption`}
          />
        )}
        {modalResult && (
          <BulkResultTable
            response={modalResult}
            captionId={`${baseId}-bulk-result-caption`}
          />
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            data-autofocus
            disabled={modalBusy}
            onClick={closeModal}
            className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {modalResult ? '閉じる' : 'キャンセル'}
          </button>
          {!modalResult && (
            <button
              type="button"
              disabled={!modalPreview || modalBusy}
              onClick={() => void executeBulk()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {modalBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              実行する
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
