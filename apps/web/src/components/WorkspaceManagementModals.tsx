'use client';

import { Loader2 } from 'lucide-react';
import { CreateFileRequestModal } from '@/components/CreateFileRequestModal';
import { ModalShell } from '@/components/ModalShell';
import { PermissionsModal } from '@/components/PermissionsModal';
import { SharePopover } from '@/components/SharePopover';
import type {
  Capability,
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export type ActiveModal =
  | {
      kind: 'permissions';
      targetType: 'folder' | 'file';
      targetId: string;
      targetName: string;
      effectiveRole: ResourceRole;
      targetCapabilities?: Capability[];
    }
  | {
      kind: 'share';
      targetType: 'folder' | 'file';
      targetId: string;
      targetName: string;
      classification: ClassificationLabel;
      canEdit: boolean;
      canManageLinks?: boolean;
    }
  | {
      kind: 'fileRequest';
      folderId: string;
      folderName: string;
      canEdit: boolean;
    }
  | { kind: 'createFolder'; parentId: string | null }
  | { kind: 'renameFolder'; folder: FolderSummary }
  | { kind: 'renameFile'; file: FileItem };

export function WorkspaceManagementModals({
  activeModal,
  folderNameInput,
  folderClassInput,
  modalSubmitting,
  onClose,
  onSubmit,
  onFolderNameChange,
  onFolderClassChange,
}: {
  activeModal: ActiveModal | null;
  folderNameInput: string;
  folderClassInput: ClassificationLabel;
  modalSubmitting: boolean;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onFolderNameChange: (value: string) => void;
  onFolderClassChange: (value: ClassificationLabel) => void;
}) {
  return (
    <>
      {activeModal?.kind === 'permissions' && (
        <PermissionsModal
          targetType={activeModal.targetType}
          targetId={activeModal.targetId}
          targetName={activeModal.targetName}
          effectiveRole={activeModal.effectiveRole}
          targetCapabilities={activeModal.targetCapabilities}
          onClose={onClose}
        />
      )}

      {activeModal?.kind === 'share' && (
        <SharePopover
          targetType={activeModal.targetType}
          targetId={activeModal.targetId}
          targetName={activeModal.targetName}
          classification={activeModal.classification}
          canEdit={activeModal.canEdit}
          canManageLinks={activeModal.canManageLinks}
          onClose={onClose}
        />
      )}

      {activeModal?.kind === 'fileRequest' && (
        <CreateFileRequestModal
          folderId={activeModal.folderId}
          folderName={activeModal.folderName}
          canEdit={activeModal.canEdit}
          onClose={onClose}
        />
      )}

      {(activeModal?.kind === 'createFolder' ||
        activeModal?.kind === 'renameFolder' ||
        activeModal?.kind === 'renameFile') && (
        <ModalShell
          label={
            activeModal.kind === 'createFolder'
              ? '新規フォルダを作成'
              : activeModal.kind === 'renameFolder'
                ? 'フォルダ名を変更'
                : 'ファイル名を変更'
          }
          onClose={onClose}
          className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
        >
          <form onSubmit={onSubmit} className="space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">
              {activeModal.kind === 'createFolder'
                ? '新規フォルダを作成'
                : activeModal.kind === 'renameFolder'
                  ? 'フォルダ名を変更'
                  : 'ファイル名を変更'}
            </h2>

            <label className="block text-xs">
              <span className="font-medium text-slate-700">
                {activeModal.kind === 'renameFile' ? 'ファイル名' : 'フォルダ名'}
              </span>
              <input
                id="workspace-modal-name"
                name="name"
                data-autofocus
                required
                autoFocus
                type="text"
                value={folderNameInput}
                onChange={(e) => onFolderNameChange(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              />
            </label>

            {activeModal.kind === 'createFolder' && (
              <label className="block text-xs">
                <span className="font-medium text-slate-700">機密分類ラベル</span>
                <select
                  id="workspace-modal-classification"
                  name="classification"
                  value={folderClassInput}
                  onChange={(e) =>
                    onFolderClassChange(
                      e.target.value as ClassificationLabel
                    )
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
                >
                  <option value="confidential">Confidential (極秘)</option>
                  <option value="internal">Internal (社内限定)</option>
                  <option value="public">Public (社外公開可)</option>
                  <option value="unset">Unset (未分類)</option>
                </select>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="submit"
                disabled={modalSubmitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {modalSubmitting && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                <span>保存</span>
              </button>
            </div>
          </form>
        </ModalShell>
      )}
    </>
  );
}
