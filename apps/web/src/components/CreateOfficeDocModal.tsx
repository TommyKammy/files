'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  createOfficeFile,
  type OfficeDocumentKind,
} from '@/lib/files-api/create-office';
import type { WorkspaceSyncStore } from '@/lib/sync-store';

export interface CreateOfficeDocModalProps {
  kind: OfficeDocumentKind | null;
  folderId: string | null;
  syncStore: WorkspaceSyncStore;
  onClose: () => void;
}

/**
 * Modal dialog for creating a new Office document (.docx, .xlsx, .pptx) in the
 * active folder and navigating to its editor route.
 */
export function CreateOfficeDocModal({
  kind,
  folderId,
  syncStore,
  onClose,
}: CreateOfficeDocModalProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind) {
      setName('');
      setSubmitting(false);
      setError(null);
    }
  }, [kind]);

  if (!kind || !folderId) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="新規Officeドキュメント作成"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || submitting) {
            return;
          }
          setSubmitting(true);
          setError(null);
          try {
            const res = await createOfficeFile({
              folderId,
              name: name.trim(),
              kind,
            });
            syncStore.upsertFileInCache(res.file);
            void syncStore
              .ensureDirectoryLoaded(folderId, { force: true })
              .catch(() => undefined);
            onClose();
            router.push(`/workspace/file/${encodeURIComponent(res.file.id)}`);
          } catch (err) {
            setSubmitting(false);
            setError(
              err instanceof Error
                ? err.message
                : 'ドキュメントの作成に失敗しました'
            );
          }
        }}
        className="w-full max-w-md rounded-xl border border-[#e1e1e4] bg-white p-5 shadow-xl"
      >
        <h2 className="text-sm font-semibold text-[#111214]">
          新規{' '}
          {kind === 'docx'
            ? 'Word (.docx)'
            : kind === 'xlsx'
              ? 'Excel (.xlsx)'
              : 'PowerPoint (.pptx)'}{' '}
          ドキュメントを作成
        </h2>
        <p className="mt-1 text-xs text-[#6b6f76]">
          ドキュメント名を入力してください（拡張子は自動で補完されます）。
        </p>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder={`例: 新規ドキュメント.${kind}`}
          className="mt-3 w-full rounded-lg border border-[#d6d7dc] px-3 py-2 text-sm text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
        />
        {error && (
          <p className="mt-2 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="rounded-lg border border-[#e1e1e4] bg-white px-3 py-1.5 text-xs font-medium text-[#3c3f46] hover:bg-[#f4f4f6]"
          >
            キャンセル
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="rounded-lg bg-[#5e6ad2] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            {submitting ? '作成中...' : '作成して開く'}
          </button>
        </div>
      </form>
    </div>
  );
}
