'use client';

import { AlertTriangle, ArchiveRestore, Loader2, Trash2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { ModalShell } from '@/components/ModalShell';
import type { AdminTrashItem } from '@/types/files';
import {
  EMPTY_TENANT_TRASH_CONFIRMATION,
  TrashIcon,
  type RestoreFormOptions,
} from './shared';

interface TrashRestoreModalProps {
  targets: AdminTrashItem[];
  options: RestoreFormOptions;
  busy: boolean;
  onOptionsChange: Dispatch<SetStateAction<RestoreFormOptions>>;
  onClose: () => void;
  onSubmit: () => void;
}

/** Confirmation modal for proxy-restoring deleted items on behalf of owners. */
export function TrashRestoreModal({
  targets,
  options,
  busy,
  onOptionsChange,
  onClose,
  onSubmit,
}: TrashRestoreModalProps) {
  return (
    <ModalShell
      label="代理復元の確認"
      labelledBy="admin-trash-restore-title"
      onClose={onClose}
      backdrop="deep"
      className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
    >
      <div className="space-y-4">
        <div>
          <h2
            id="admin-trash-restore-title"
            className="text-sm font-semibold text-slate-900"
          >
            代理復元の確認
          </h2>
          <p className="mt-1 text-[0.6875rem] text-[#55565a]">
            {targets.length} 件を、所有者の代理として復元します。
          </p>
        </div>

        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-[0.6875rem]">
          {targets.map((item) => (
            <li
              key={`${item.type}:${item.id}`}
              className="flex items-center justify-between gap-3"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <TrashIcon type={item.type} />
                <span className="truncate font-medium text-slate-800">
                  {item.name}
                </span>
              </span>
              <span className="shrink-0 text-slate-500">
                {item.owner?.name ?? '所有者不明'}
              </span>
            </li>
          ))}
        </ul>

        <fieldset className="space-y-2">
          <legend className="text-[0.6875rem] font-medium text-[#55565a]">
            復元先
          </legend>
          <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
            <input
              type="radio"
              name="admin-trash-restore-target"
              value="original"
              checked={options.target === 'original'}
              onChange={() =>
                onOptionsChange((prev) => ({ ...prev, target: 'original' }))
              }
              className="mt-0.5"
            />
            <span>
              元の場所に戻す
              <span className="block text-[0.6875rem] text-[#8a8c91]">
                親フォルダが削除済みの場合は下の自動復元を有効にしてください。
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
            <input
              type="radio"
              name="admin-trash-restore-target"
              value="root"
              checked={options.target === 'root'}
              onChange={() =>
                onOptionsChange((prev) => ({ ...prev, target: 'root' }))
              }
              className="mt-0.5"
            />
            <span>マイファイル (ルート) に戻す</span>
          </label>
        </fieldset>

        <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
          <input
            type="checkbox"
            checked={options.restoreParentChain}
            onChange={(event) =>
              onOptionsChange((prev) => ({
                ...prev,
                restoreParentChain: event.target.checked,
              }))
            }
            className="mt-0.5"
          />
          <span>
            親フォルダが削除済みの場合は自動復元する
            <span className="block text-[0.6875rem] text-[#8a8c91]">
              対象アイテムの祖先フォルダだけを復元します。
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
          <input
            type="checkbox"
            checked={options.renameOnConflict}
            onChange={(event) =>
              onOptionsChange((prev) => ({
                ...prev,
                renameOnConflict: event.target.checked,
              }))
            }
            className="mt-0.5"
          />
          <span>
            名前が衝突した場合は自動リネームする
            <span className="block text-[0.6875rem] text-[#8a8c91]">
              既存ファイルは上書きされません。
            </span>
          </span>
        </label>

        <p className="rounded-md border border-[#dfe2f5] bg-[#eef0fb] px-3 py-2 text-[0.6875rem] text-[#3c3f46]">
          復元は管理者の代理操作として監査ログに記録され、所有者のワークスペースにも通知されます。
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            復元を実行
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

interface TrashPurgeModalProps {
  targets: AdminTrashItem[];
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
}

/** Confirmation modal for permanently purging selected trash items. */
export function TrashPurgeModal({
  targets,
  busy,
  onClose,
  onSubmit,
}: TrashPurgeModalProps) {
  return (
    <ModalShell
      label="選択項目の完全削除"
      labelledBy="admin-trash-purge-title"
      onClose={onClose}
      backdrop="deep"
      className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
            aria-hidden="true"
          />
          <div>
            <h2
              id="admin-trash-purge-title"
              className="text-sm font-semibold text-slate-900"
            >
              選択項目の完全削除
            </h2>
            <p className="mt-1 text-[0.6875rem] text-[#55565a]">
              {targets.length}{' '}
              件を完全削除します。この操作は取り消せません。ロック中のファイルは安全のためスキップされます。
            </p>
          </div>
        </div>
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-red-100 bg-red-50/50 px-3 py-2 text-[0.6875rem]">
          {targets.map((item) => (
            <li
              key={`${item.type}:${item.id}`}
              className="flex items-center gap-1.5"
            >
              <TrashIcon type={item.type} />
              <span className="truncate font-medium text-slate-800">
                {item.name}
              </span>
              <span className="shrink-0 text-slate-500">
                {item.owner?.name ?? '所有者不明'}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-[0.75rem] font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            完全削除を実行
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

interface TrashEmptyModalProps {
  confirmText: string;
  busy: boolean;
  onConfirmTextChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

/** Confirmation modal for emptying the entire tenant trash with explicit text confirmation. */
export function TrashEmptyModal({
  confirmText,
  busy,
  onConfirmTextChange,
  onClose,
  onSubmit,
}: TrashEmptyModalProps) {
  return (
    <ModalShell
      label="テナント全体のゴミ箱を空にする確認"
      labelledBy="admin-trash-empty-title"
      onClose={onClose}
      backdrop="deep"
      className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
            aria-hidden="true"
          />
          <div>
            <h2
              id="admin-trash-empty-title"
              className="text-sm font-semibold text-slate-900"
            >
              テナント全体のゴミ箱を空にする
            </h2>
            <p className="mt-1 text-[0.6875rem] text-[#55565a]">
              他ユーザーが削除したものを含む、テナント内のすべてのゴミ箱アイテムを完全削除します。この操作は取り消せません。ロック中のファイルはスキップされ、後で再実行できます。
            </p>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-slate-700">
          <span>確認文字列</span>
          <input
            type="text"
            aria-label="確認文字列"
            data-autofocus
            autoComplete="off"
            spellCheck={false}
            value={confirmText}
            onChange={(event) => onConfirmTextChange(event.target.value)}
            placeholder={EMPTY_TENANT_TRASH_CONFIRMATION}
            className="h-8 rounded-md border border-slate-300 bg-white px-2 font-mono text-[0.8125rem] text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-400/50"
          />
          <span className="text-[0.6875rem] text-[#8a8c91]">
            続行するには {EMPTY_TENANT_TRASH_CONFIRMATION} と入力してください。
          </span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || confirmText !== EMPTY_TENANT_TRASH_CONFIRMATION}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-[0.75rem] font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            空にする
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
