'use client';

import { SlidersHorizontal } from 'lucide-react';
import {
  CAPABILITY_CHIPS,
  RESOURCE_ROLES,
  ROLE_CAPABILITIES,
  ROLE_META,
} from '@/lib/capabilities';
import type { Capability } from '@/types/files';

/** Columns of the read-only 8-role capability matrix. */
const ADVANCED_ROLE_MATRIX_CAPABILITIES: readonly Capability[] = [
  'folder.list',
  'item.preview',
  'item.download',
  'item.upload_new',
  'item.upload_version',
  'item.edit_content',
  'item.delete',
  'permission.manage',
];

export function ImpactSummaryCard() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
        <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
        ポリシー変更の影響
      </h3>
      <ul className="mt-2 space-y-1.5 text-[0.6875rem] leading-relaxed text-slate-600">
        <li>
          ・<strong>有効化</strong>すると、フォルダの権限画面で
          <span className="font-mono"> Uploader </span>
          /
          <span className="font-mono"> Previewer + Uploader </span>
          /
          <span className="font-mono"> Viewer + Uploader </span>
          を付与できます。ファイルには付与できません。
        </li>
        <li>
          ・<strong>無効化</strong>すると新規付与は
          <span className="font-mono"> ADVANCED_ROLES_DISABLED </span>
          でブロックされます。既存の高度ロール付与は自動削除されず、管理者が更新または取り消すまで有効です。
        </li>
        <li>
          ・<strong>Uploader</strong> は新規アップロード専用で、一覧・プレビュー・ダウンロードはできません。
          <strong>Previewer + Uploader</strong>{' '}
          はプレビューと新規アップロードのみで、DL・既存版の上書き・WOPI
          編集はできません。
        </li>
        <li>
          ・<strong>Viewer + Uploader</strong> は閲覧・DL・WOPI
          編集・新規/新版アップロードが可能ですが、名前変更・移動・削除・権限管理・機密区分変更はできません。作成できる共有リンクは表示専用（DL不可・透かし付き）です。
        </li>
      </ul>
    </div>
  );
}

export function AdvancedRoleMatrix() {
  return (
    <details
      data-testid="advanced-roles-matrix-details"
      className="border-t border-slate-200"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs font-semibold text-slate-800 [&::-webkit-details-marker]:hidden">
        <span>8ロール権限マトリクス (参照)</span>
        <span
          aria-hidden="true"
          className="text-[0.625rem] font-medium text-slate-500"
        >
          マトリクスを表示 / 折りたたむ
        </span>
      </summary>
      <div
        role="region"
        aria-label="8ロール権限マトリクス"
        tabIndex={0}
        className="overflow-x-auto px-5 pb-4"
      >
        <table className="w-full min-w-[44rem] border-collapse text-left text-[0.6875rem]">
          <caption className="sr-only">
            8つのリソースロールと主要 Capability の対応表。✓ は付与、— は不可を表します。
          </caption>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <th scope="col" className="px-2 py-2 font-medium">
                ロール
              </th>
              {ADVANCED_ROLE_MATRIX_CAPABILITIES.map((capability) => (
                <th
                  key={capability}
                  scope="col"
                  className="px-2 py-2 text-center font-medium"
                >
                  {CAPABILITY_CHIPS[capability]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RESOURCE_ROLES.map((role) => (
              <tr
                key={role}
                data-testid={`advanced-role-matrix-row-${role}`}
                className="border-b border-slate-100 last:border-b-0"
              >
                <th scope="row" className="px-2 py-2 font-medium text-slate-900">
                  {ROLE_META[role].label}
                </th>
                {ADVANCED_ROLE_MATRIX_CAPABILITIES.map((capability) => {
                  const granted = ROLE_CAPABILITIES[role].has(capability);
                  return (
                    <td
                      key={capability}
                      className={`px-2 py-2 text-center ${
                        granted ? 'text-emerald-700' : 'text-slate-400'
                      }`}
                    >
                      <span aria-hidden="true">{granted ? '✓' : '—'}</span>
                      <span className="sr-only">
                        {granted ? '可' : '不可'}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
