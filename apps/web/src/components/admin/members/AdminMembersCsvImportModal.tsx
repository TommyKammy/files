'use client';

import { FileSpreadsheet, Loader2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  ADMIN_MEMBER_BULK_ACTION_LABELS,
  ADMIN_MEMBER_CSV_SAMPLE,
  bulkRowLabel,
  createMemberIdempotencyKey,
  formatBulkImportSummary,
} from '@/lib/admin-users';
import { ApiClientError, bulkImportAdminMembers } from '@/lib/files-api';
import type { AdminMemberBulkImportResponse } from '@/types/files';

interface AdminMembersCsvImportModalProps {
  onClose: () => void;
  onImported: (notice: string | null) => void;
}

export function AdminMembersCsvImportModal({
  onClose,
  onImported,
}: AdminMembersCsvImportModalProps) {
  const baseId = useId();
  const [bulkCsv, setBulkCsv] = useState(ADMIN_MEMBER_CSV_SAMPLE);
  const [bulkKey] = useState(() => createMemberIdempotencyKey('bulk-import'));
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] =
    useState<AdminMemberBulkImportResponse | null>(null);

  function closeBulk() {
    if (bulkBusy) return;
    onClose();
  }

  async function runBulk(dryRun: boolean) {
    if (bulkBusy) return;
    if (bulkCsv.trim().length === 0) {
      setBulkError('CSV テキストを入力してください。');
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    try {
      const response = await bulkImportAdminMembers({
        csv: bulkCsv,
        dryRun,
        idempotencyKey: bulkKey,
      });
      setBulkResult(response);
      if (!dryRun) {
        onImported(response.notice);
      }
    } catch (err) {
      setBulkError(
        err instanceof ApiClientError
          ? err.message
          : 'CSV 一括登録に失敗しました'
      );
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <ModalShell
      label="CSV 一括登録"
      labelledBy={`${baseId}-bulk-heading`}
      onClose={closeBulk}
      className="w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div data-testid="member-bulk-modal" className="flex max-h-[88vh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h3
              id={`${baseId}-bulk-heading`}
              className="text-sm font-semibold text-slate-900"
            >
              CSV 一括登録 / 更新
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              最大 200 件。既存メールは更新、未登録メールは新規作成します。
              まず dryRun でプレビューできます。
            </p>
          </div>
          <button
            type="button"
            data-testid="member-bulk-close"
            aria-label="CSV 一括登録を閉じる"
            onClick={closeBulk}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="grid flex-1 gap-4 overflow-y-auto px-5 py-4 text-xs lg:grid-cols-2">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor={`${baseId}-bulk-csv`}
                className="text-[0.6875rem] font-medium text-slate-700"
              >
                UTF-8 CSV
              </label>
              <button
                type="button"
                data-testid="member-bulk-sample"
                onClick={() => setBulkCsv(ADMIN_MEMBER_CSV_SAMPLE)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-100"
              >
                <FileSpreadsheet className="h-3 w-3" aria-hidden="true" />
                サンプル CSV
              </button>
            </div>
            <textarea
              id={`${baseId}-bulk-csv`}
              data-testid="member-bulk-csv"
              data-autofocus
              value={bulkCsv}
              onChange={(event) => setBulkCsv(event.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full rounded-lg border border-slate-300 p-2 font-mono text-[0.6875rem] text-slate-900"
            />
            <p className="text-[0.625rem] text-slate-500">
              対応ヘッダー: email, displayName, department, role,
              storageQuotaBytes（空欄は上限なし）
            </p>
            <p
              data-testid="member-bulk-idempotency-key"
              className="break-all font-mono text-[0.625rem] text-slate-500"
            >
              Idempotency-Key: {bulkKey}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="member-bulk-dry-run"
                disabled={bulkBusy}
                onClick={() => void runBulk(true)}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-[#5e6ad2] bg-white px-3 text-xs font-medium text-[#3f4aa8] hover:bg-[#f2f3fb] disabled:opacity-50"
              >
                {bulkBusy && (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                )}
                dryRun プレビュー
              </button>
              <button
                type="button"
                data-testid="member-bulk-execute"
                disabled={bulkBusy}
                onClick={() => void runBulk(false)}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                一括登録を実行
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {bulkError && (
              <div
                role="alert"
                data-testid="member-bulk-error"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
              >
                {bulkError}
              </div>
            )}
            {bulkResult ? (
              <div className="space-y-2">
                <div
                  data-testid="member-bulk-result"
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900"
                >
                  <p data-testid="member-bulk-summary" className="font-medium">
                    {formatBulkImportSummary(bulkResult)}
                  </p>
                  <p className="mt-0.5 text-[0.625rem]">
                    {bulkResult.dryRun
                      ? 'プレビューのためデータは変更されていません。'
                      : bulkResult.replayed
                        ? '同じ Idempotency-Key の保存済み結果を再生しました（再実行なし）。'
                        : bulkResult.notice}
                  </p>
                </div>
                <div className="max-h-[24rem] overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-[0.625rem]">
                    <caption className="sr-only">
                      CSV 一括登録の行別結果
                    </caption>
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th scope="col" className="px-2 py-1 font-medium">
                          行
                        </th>
                        <th scope="col" className="px-2 py-1 font-medium">
                          メール
                        </th>
                        <th scope="col" className="px-2 py-1 font-medium">
                          結果
                        </th>
                        <th scope="col" className="px-2 py-1 font-medium">
                          内容
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkResult.results.map((row) => (
                        <tr
                          key={`${row.rowNumber}-${row.email}`}
                          data-testid="member-bulk-row"
                          className="border-t border-slate-100"
                        >
                          <td className="px-2 py-1 text-slate-500">
                            {row.rowNumber}
                          </td>
                          <td className="px-2 py-1 font-mono text-slate-700">
                            {row.email || '—'}
                          </td>
                          <td className="px-2 py-1">
                            <span
                              className={`inline-flex rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold ${
                                row.action === 'error'
                                  ? 'bg-red-50 text-red-700'
                                  : row.action === 'create'
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : row.action === 'update'
                                      ? 'bg-blue-50 text-blue-700'
                                      : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {ADMIN_MEMBER_BULK_ACTION_LABELS[row.action]}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-slate-600">
                            {row.error
                              ? row.code
                                ? `${row.error} (${row.code})`
                                : row.error
                              : bulkRowLabel(row)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-6 text-center text-[0.6875rem] text-slate-500">
                dryRun プレビューまたは一括登録を実行すると、行別の結果が
                ここに表示されます。
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
