'use client';

import { Check, Sparkles } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { CLASSIFICATION_META } from '@/lib/formatters';
import { getWorkspaceSyncStore } from '@/lib/sync-store';
import type {
  ClassificationLabel,
  FileItem,
  ResourceRole,
} from '@/types/files';

const ASSIGNABLE_OPTIONS: Array<Exclude<ClassificationLabel, 'unset'>> = [
  'confidential',
  'internal',
  'public',
];

export function ClassificationCell({
  file,
  canEdit,
  effectiveRole,
  isPrivilegedAdmin,
  onUpdated,
  onError,
}: {
  file: FileItem;
  canEdit: boolean;
  effectiveRole?: ResourceRole;
  isPrivilegedAdmin?: boolean;
  onUpdated?: (updatedFile: FileItem) => void;
  onError: (message: string) => void;
}) {
  const isPendingUpload = file.upload_state === 'pending' || Boolean(file.optimistic);
  const editable = canEdit && !isPendingUpload;

  const hasPendingSuggestion =
    !isPendingUpload &&
    Boolean(file.ai_suggested_label) &&
    file.ai_suggested_label !== 'unset' &&
    file.ai_suggested_label !== file.classification;

  function handleApproveSuggestion() {
    if (!editable || !hasPendingSuggestion) return;
    const res = getWorkspaceSyncStore().optimisticUpdateFileClassification(
      file,
      { acceptSuggestion: true },
      { effectiveRole, isPrivilegedAdmin }
    );
    if (!res.ok) {
      onError(res.error ?? 'AI提案の承認に失敗しました');
      return;
    }
    if (res.file) {
      onUpdated?.(res.file);
    }
  }

  function handleManualChange(nextLabel: ClassificationLabel) {
    if (!editable || nextLabel === 'unset' || nextLabel === file.classification) {
      return;
    }
    const res = getWorkspaceSyncStore().optimisticUpdateFileClassification(
      file,
      { classification: nextLabel },
      { effectiveRole, isPrivilegedAdmin }
    );
    if (!res.ok) {
      onError(res.error ?? '分類ラベルの更新に失敗しました');
      return;
    }
    if (res.file) {
      onUpdated?.(res.file);
    }
  }

  const confidencePct =
    typeof file.ai_confidence === 'number'
      ? Math.round(file.ai_confidence * 100)
      : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {editable ? (
          <select
            aria-label={`${file.name} の分類ラベル`}
            value={file.classification}
            onChange={(e) =>
              handleManualChange(e.target.value as ClassificationLabel)
            }
            className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-800 shadow-2xs hover:border-slate-300 focus:border-blue-500 focus:outline-none"
          >
            {file.classification === 'unset' && (
              <option value="unset">Unset (未分類)</option>
            )}
            {ASSIGNABLE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {CLASSIFICATION_META[opt].label} ({CLASSIFICATION_META[opt].shortJa})
              </option>
            ))}
          </select>
        ) : (
          <ClassificationBadge
            classification={file.classification}
            labelOverride={isPendingUpload ? '解析待ち' : undefined}
          />
        )}
      </div>

      {hasPendingSuggestion && file.ai_suggested_label && (
        <div
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50/90 px-2 py-0.5 text-[11px] text-indigo-800"
          title={file.ai_reason ?? 'Workers AI による分類提案'}
        >
          <Sparkles className="h-3 w-3 shrink-0 text-indigo-600" />
          <span className="truncate font-medium">
            AI提案: {CLASSIFICATION_META[file.ai_suggested_label].label}
            {confidencePct !== null ? ` (${confidencePct}%)` : ''}
          </span>
          {editable && (
            <button
              type="button"
              onClick={handleApproveSuggestion}
              title={
                file.ai_reason
                  ? `理由: ${file.ai_reason} — クリックで承認`
                  : 'AI提案を1クリック承認'
              }
              className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-indigo-600 text-white hover:bg-indigo-700"
            >
              <Check className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
