'use client';

import { CheckSquare, Loader2, Sparkles } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import type {
  AiSuggestionItem,
  ClassificationLabel,
} from '@/types/files';

export function AiSuggestionQueue({
  suggestions,
  selectedIds,
  labelFilter,
  bulkBusy,
  onFilterChange,
  onSelectAll,
  onBulkApprove,
  onSingleApprove,
  onToggleSelection,
}: {
  suggestions: AiSuggestionItem[];
  selectedIds: Set<string>;
  labelFilter: ClassificationLabel | 'all';
  bulkBusy: boolean;
  onFilterChange: (value: ClassificationLabel | 'all') => void;
  onSelectAll: (checked: boolean) => void;
  onBulkApprove: () => void;
  onSingleApprove: (fileId: string) => void;
  onToggleSelection: (fileId: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-600" />
          <h2 className="text-sm font-semibold text-slate-900">
            AI 機密分類 提案レビューキュー ({suggestions.length})
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            id="ai-label-filter"
            name="labelFilter"
            aria-label="AI 提案の機密区分で絞り込む"
            value={labelFilter}
            onChange={(e) =>
              onFilterChange(e.target.value as ClassificationLabel | 'all')
            }
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
          >
            <option value="all">すべての AI 提案</option>
            <option value="confidential">Confidential 提案のみ</option>
            <option value="internal">Internal 提案のみ</option>
            <option value="public">Public 提案のみ</option>
          </select>

          <button
            type="button"
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={onBulkApprove}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {bulkBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckSquare className="h-3.5 w-3.5" />
            )}
            <span>選択 {selectedIds.size}件を一括承認</span>
          </button>
        </div>
      </div>

      {suggestions.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-slate-500">
          承認待ちの AI 分類提案はありません
        </div>
      ) : (
        <div
          role="region"
          aria-label="AI 機密分類の提案レビューキュー"
          tabIndex={0}
          className="overflow-x-auto"
        >
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              AI 機密分類の提案レビューキュー
            </caption>
            <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
              <tr>
                <th scope="col" className="w-10 px-4 py-2.5">
                  <label
                    htmlFor="ai-suggestion-select-all"
                    className="flex h-6 w-6 items-center justify-center"
                  >
                    <input
                      id="ai-suggestion-select-all"
                      name="selectAllSuggestions"
                      aria-label="すべての AI 提案を選択"
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-[#5e6ad2]"
                      checked={
                        suggestions.length > 0 &&
                        selectedIds.size === suggestions.length
                      }
                      onChange={(e) => onSelectAll(e.target.checked)}
                    />
                  </label>
                </th>
                <th scope="col" className="px-4 py-2.5">
                  ファイル
                </th>
                <th scope="col" className="px-4 py-2.5">
                  現在
                </th>
                <th scope="col" className="px-4 py-2.5">
                  AI 提案 & 信頼度
                </th>
                <th scope="col" className="px-4 py-2.5">
                  推論理由
                </th>
                <th scope="col" className="px-4 py-2.5 text-right">
                  承認
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {suggestions.map((item) => (
                <tr key={item.fileId} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2.5">
                    <label
                      htmlFor={`ai-suggestion-${item.fileId}`}
                      className="flex h-6 w-6 items-center justify-center"
                    >
                      <input
                        id={`ai-suggestion-${item.fileId}`}
                        name="selectedSuggestion"
                        aria-label={`${item.name} を選択`}
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-[#5e6ad2]"
                        checked={selectedIds.has(item.fileId)}
                        onChange={() => onToggleSelection(item.fileId)}
                      />
                    </label>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-900">
                      {item.name}
                    </div>
                    <div className="text-[0.6875rem] text-slate-500">
                      {item.folderName ?? 'Root'} • {item.uploaderEmail ?? '—'}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <ClassificationBadge
                      classification={item.currentClassification}
                      compact
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <ClassificationBadge
                        classification={item.suggestedLabel}
                        compact
                      />
                      {typeof item.confidence === 'number' && (
                        <span className="font-mono text-[0.6875rem] text-slate-600">
                          {Math.round(item.confidence * 100)}%
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    className="max-w-xs truncate px-4 py-2.5 text-slate-600"
                    title={item.reason ?? ''}
                  >
                    {item.reason ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right space-x-1">
                    <button
                      type="button"
                      onClick={() => onSingleApprove(item.fileId)}
                      className="rounded-md bg-indigo-50 px-2.5 py-1 text-[0.6875rem] font-semibold text-indigo-700 hover:bg-indigo-100"
                    >
                      提案通り承認
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
