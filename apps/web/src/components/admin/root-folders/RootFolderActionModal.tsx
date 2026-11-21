'use client';

import {
  Archive,
  ArchiveRestore,
  FolderPlus,
  Loader2,
  UserCog,
  Users,
} from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';
import {
  PrincipalPicker,
  ROOT_FOLDER_FIELD_CLASS,
} from '@/components/admin/root-folders/PrincipalPicker';
import type { RootFolderModalState } from '@/components/admin/root-folders/RootFoldersTable';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type { ClassificationLabel, PrincipalCandidate } from '@/types/files';

const CREATE_DIALOG_LABEL = '新規ルートフォルダを作成';
const TRANSFER_DIALOG_LABEL = 'ルートフォルダの所有者を移管';
const CO_OWNER_DIALOG_LABEL = '共同所有者を一括付与';
const ARCHIVE_DIALOG_LABEL = 'ルートフォルダをアーカイブ';
const RESTORE_DIALOG_LABEL = 'ルートフォルダを復元';

export function RootFolderActionModal({
  modal,
  busy,
  modalError,
  createName,
  createClassification,
  createOwner,
  createCoOwners,
  transferOwner,
  demotePreviousOwnersTo,
  coOwnerGrants,
  onClose,
  onChangeCreateName,
  onChangeCreateClassification,
  onChangeCreateOwner,
  onChangeCreateCoOwners,
  onChangeTransferOwner,
  onChangeDemotePreviousOwnersTo,
  onChangeCoOwnerGrants,
  onSubmitCreate,
  onSubmitTransfer,
  onSubmitCoOwners,
  onSubmitArchiveOrRestore,
}: {
  modal: RootFolderModalState;
  busy: boolean;
  modalError: string | null;
  createName: string;
  createClassification: ClassificationLabel;
  createOwner: PrincipalCandidate[];
  createCoOwners: PrincipalCandidate[];
  transferOwner: PrincipalCandidate[];
  demotePreviousOwnersTo: 'co_owner' | 'editor' | 'revoke';
  coOwnerGrants: PrincipalCandidate[];
  onClose: () => void;
  onChangeCreateName: (name: string) => void;
  onChangeCreateClassification: (value: ClassificationLabel) => void;
  onChangeCreateOwner: (next: PrincipalCandidate[]) => void;
  onChangeCreateCoOwners: (next: PrincipalCandidate[]) => void;
  onChangeTransferOwner: (next: PrincipalCandidate[]) => void;
  onChangeDemotePreviousOwnersTo: (
    value: 'co_owner' | 'editor' | 'revoke'
  ) => void;
  onChangeCoOwnerGrants: (next: PrincipalCandidate[]) => void;
  onSubmitCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onSubmitTransfer: (event: React.FormEvent<HTMLFormElement>) => void;
  onSubmitCoOwners: (event: React.FormEvent<HTMLFormElement>) => void;
  onSubmitArchiveOrRestore: () => void;
}) {
  const dialogLabel =
    modal.kind === 'create'
      ? CREATE_DIALOG_LABEL
      : modal.kind === 'transfer'
        ? TRANSFER_DIALOG_LABEL
        : modal.kind === 'coowners'
          ? CO_OWNER_DIALOG_LABEL
          : modal.kind === 'archive'
            ? ARCHIVE_DIALOG_LABEL
            : modal.kind === 'restore'
              ? RESTORE_DIALOG_LABEL
              : 'ルートフォルダ操作';

  return (
    <ModalShell
      label={
        modal.root && modal.kind !== 'create'
          ? `${dialogLabel}: ${modal.root.name}`
          : dialogLabel
      }
      onClose={onClose}
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <ModalHeader
        icon={
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            {modal.kind === 'archive' ? (
              <Archive className="h-4 w-4" />
            ) : modal.kind === 'restore' ? (
              <ArchiveRestore className="h-4 w-4" />
            ) : modal.kind === 'coowners' ? (
              <Users className="h-4 w-4" />
            ) : modal.kind === 'transfer' ? (
              <UserCog className="h-4 w-4" />
            ) : (
              <FolderPlus className="h-4 w-4" />
            )}
          </span>
        }
        title={
          modal.kind === 'create'
            ? CREATE_DIALOG_LABEL
            : modal.kind === 'transfer'
              ? `${TRANSFER_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
              : modal.kind === 'coowners'
                ? `${CO_OWNER_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
                : modal.kind === 'archive'
                  ? `${ARCHIVE_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
                  : `${RESTORE_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
        }
        subtitle={
          modal.kind === 'create'
            ? '所有者と共同所有者を同時に設定します。'
            : modal.kind === 'archive'
              ? '配下のフォルダ・ファイルもまとめてアーカイブされます。'
              : modal.kind === 'restore'
                ? 'アーカイブされていた配下のフォルダ・ファイルも復元されます。'
                : undefined
        }
        onClose={onClose}
      />

      {(modal.kind === 'archive' || modal.kind === 'restore') && (
        <div className="space-y-3 px-5 py-4 text-xs">
          <ModalError message={modalError} />
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900">
            {modal.kind === 'archive'
              ? 'アーカイブすると、このルート配下のアイテムはワークスペースから非表示になります。削除ではなく復元可能です。'
              : '復元すると、アーカイブ時に非表示になった配下のフォルダ・ファイルが再び表示されます。'}
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              data-autofocus
              disabled={busy}
              onClick={onSubmitArchiveOrRestore}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-xs font-semibold text-white disabled:opacity-50 ${
                modal.kind === 'archive'
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {modal.kind === 'archive' ? 'アーカイブする' : '復元する'}
            </button>
          </div>
        </div>
      )}

      {modal.kind === 'create' && (
        <form
          onSubmit={onSubmitCreate}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
              event.preventDefault();
            }
          }}
          className="space-y-3 px-5 py-4 text-xs"
        >
          <ModalError message={modalError} />
          <div>
            <label
              htmlFor="root-folder-name"
              className="block text-xs font-medium text-slate-700"
            >
              フォルダ名
            </label>
            <input
              id="root-folder-name"
              name="rootFolderName"
              type="text"
              required
              maxLength={255}
              value={createName}
              onChange={(event) => onChangeCreateName(event.target.value)}
              className={`${ROOT_FOLDER_FIELD_CLASS} mt-1`}
            />
          </div>
          <div>
            <label
              htmlFor="root-folder-classification"
              className="block text-xs font-medium text-slate-700"
            >
              機密区分
            </label>
            <select
              id="root-folder-classification"
              name="rootFolderClassification"
              value={createClassification}
              onChange={(event) =>
                onChangeCreateClassification(
                  event.target.value as ClassificationLabel
                )
              }
              className={`${ROOT_FOLDER_FIELD_CLASS} mt-1`}
            >
              <option value="unset">未設定</option>
              <option value="public">公開</option>
              <option value="internal">社内</option>
              <option value="confidential">極秘</option>
            </select>
          </div>
          <PrincipalPicker
            label="所有者 (Owner)"
            description="テナント内のアクティブユーザーを1名選択します。"
            inputId="root-folder-owner-search"
            principals={createOwner}
            allowGroups={false}
            single
            onChange={onChangeCreateOwner}
          />
          <PrincipalPicker
            label="共同所有者 (Co-Owner)"
            description="任意のユーザーまたは SCIM グループを複数選択できます。"
            inputId="root-folder-coowner-search"
            principals={createCoOwners}
            allowGroups
            onChange={onChangeCreateCoOwners}
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              作成する
            </button>
          </div>
        </form>
      )}

      {modal.kind === 'transfer' && (
        <form
          onSubmit={onSubmitTransfer}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
              event.preventDefault();
            }
          }}
          className="space-y-3 px-5 py-4 text-xs"
        >
          <ModalError message={modalError} />
          <PrincipalPicker
            label="新しい所有者"
            description="テナント内のアクティブユーザーを選択します。"
            inputId="root-folder-transfer-owner-search"
            principals={transferOwner}
            allowGroups={false}
            single
            onChange={onChangeTransferOwner}
          />
          <div>
            <label
              htmlFor="root-folder-demote"
              className="block text-xs font-medium text-slate-700"
            >
              以前の所有者の扱い
            </label>
            <select
              id="root-folder-demote"
              name="demotePreviousOwnersTo"
              value={demotePreviousOwnersTo}
              onChange={(event) =>
                onChangeDemotePreviousOwnersTo(
                  event.target.value as 'co_owner' | 'editor' | 'revoke'
                )
              }
              className={`${ROOT_FOLDER_FIELD_CLASS} mt-1`}
            >
              <option value="co_owner">共同所有者 (co_owner) へ降格</option>
              <option value="editor">編集者 (editor) へ降格</option>
              <option value="revoke">権限を削除</option>
            </select>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
              新しい所有者は常に有効な owner として残るため、所有者が 0
              名になることはありません（最終所有者ガード）。
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              所有者を移管する
            </button>
          </div>
        </form>
      )}

      {modal.kind === 'coowners' && (
        <form
          onSubmit={onSubmitCoOwners}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
              event.preventDefault();
            }
          }}
          className="space-y-3 px-5 py-4 text-xs"
        >
          <ModalError message={modalError} />
          <PrincipalPicker
            label="共同所有者 (Co-Owner)"
            description="ユーザーまたは SCIM グループを複数選択します。既存の owner は降格されません。"
            inputId="root-folder-bulk-coowner-search"
            principals={coOwnerGrants}
            allowGroups
            onChange={onChangeCoOwnerGrants}
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              一括付与する
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}
