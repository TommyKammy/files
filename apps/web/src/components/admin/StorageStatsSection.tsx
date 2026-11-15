'use client';

import { Database } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { CLASSIFICATION_META, formatBytes } from '@/lib/formatters';
import type {
  ClassificationLabel,
  StorageStatsResponse,
} from '@/types/files';

const CLASS_ORDER: ClassificationLabel[] = [
  'confidential',
  'internal',
  'public',
  'unset',
];

export function StorageStatsSection({
  stats,
  usedPct,
}: {
  stats: StorageStatsResponse;
  usedPct: number;
}) {
  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 rounded-lg border border-[#e7e7ea] bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              ストレージ使用量 & 機密分類内訳
            </h2>
            <p className="text-[0.6875rem] text-[#55565a]">
              {formatBytes(stats.usedBytes)} / {formatBytes(stats.quotaBytes)} (
              {usedPct}%) • 合計 {stats.totalFiles} ファイル
            </p>
          </div>
        </div>

        <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
          {CLASS_ORDER.map((label) => {
            const item = stats.byClassification[label];
            const widthPct =
              stats.usedBytes > 0
                ? (item.totalBytes / stats.usedBytes) * 100
                : 0;
            if (widthPct <= 0) return null;
            return (
              <div
                key={label}
                className={CLASSIFICATION_META[label].barClass}
                style={{ width: `${widthPct}%` }}
                title={`${CLASSIFICATION_META[label].label}: ${formatBytes(
                  item.totalBytes
                )} (${item.fileCount} files)`}
              />
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CLASS_ORDER.map((label) => {
            const item = stats.byClassification[label];
            return (
              <div
                key={label}
                className="rounded-xl border border-slate-100 bg-slate-50/70 p-3"
              >
                <ClassificationBadge classification={label} compact />
                <div className="mt-2 font-mono text-sm font-semibold text-slate-900">
                  {formatBytes(item.totalBytes)}
                </div>
                <div className="text-[0.6875rem] text-slate-500">
                  {item.fileCount} ファイル
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-[#e7e7ea] bg-white p-5 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Database className="h-4 w-4 text-indigo-600" />
            <span>D1 メタデータ DB サイズ監視</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            SQLite pragma_page_count × page_size による推定容量
          </p>
        </div>
        <div className="my-4">
          <div className="font-mono text-2xl font-bold text-slate-900">
            {stats.d1EstimatedBytes !== null
              ? formatBytes(stats.d1EstimatedBytes)
              : '取得不可'}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            残りクォータ: {formatBytes(stats.remainingBytes)}
          </div>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-600">
          集計は tenant_storage_stats から O(1) で取得しています（全件スキャンなし）
        </div>
      </div>
    </section>
  );
}
