'use client';

import { Activity, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  AdminSharedLinkRow,
  AiClassificationMode,
  TenantPolicyRow,
} from '@/types/files';

/** Native checkbox rendered as a switch (React typings omit the attribute). */
const NATIVE_SWITCH_ATTRS = {
  switch: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

export function SharedLinksPolicySection({
  sharedLinks,
  policy,
  policySaving,
  onEmergencyRevoke,
  onPolicySubmit,
  onPolicyChange,
  showLegacyFields = true,
}: {
  sharedLinks: AdminSharedLinkRow[];
  policy: TenantPolicyRow | null;
  policySaving: boolean;
  onEmergencyRevoke: (linkId: string) => void;
  onPolicySubmit: (event: React.FormEvent) => void;
  onPolicyChange: (next: TenantPolicyRow) => void;
  /** Keeps the retention/AI fields in their original topic for compatibility. */
  showLegacyFields?: boolean;
}) {
  const [monitorOpen, setMonitorOpen] = useState(sharedLinks.length > 0);

  useEffect(() => {
    setMonitorOpen(sharedLinks.length > 0);
  }, [sharedLinks.length]);

  return (
    <section
      data-testid="shared-links-policy-section"
      aria-label="共有リンクポリシー"
      className="space-y-4"
    >
      {policy && (
        <form
          onSubmit={onPolicySubmit}
          aria-labelledby="shared-links-policy-heading"
          className="rounded-lg border border-[#e7e7ea] bg-white p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2
                id="shared-links-policy-heading"
                className="flex items-center gap-2 text-sm font-semibold text-slate-900"
              >
                <SlidersHorizontal className="h-4 w-4 text-[#5e6ad2]" />
                共有リンクポリシー
              </h2>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
                共有リンクの SSO 限定・透かし・編集権限・最大有効期限を決めます。
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
              最大 {policy.max_link_expiration_days} 日
            </span>
          </div>

          <div className="mt-4 space-y-4">
            <label className="flex items-center justify-between gap-3 rounded-xl border border-[#e7e7ea] px-3 py-2.5 text-xs">
              <span>
                <span className="block font-medium text-slate-800">
                  共有リンクを社内SSO限定に強制
                </span>
                <span className="mt-0.5 block text-[0.625rem] text-slate-500">
                  社外の匿名アクセスを拒否し、社内 SSO セッションだけに限定します。
                </span>
              </span>
              <input
                id="policy-enforce-company-only"
                name="enforceCompanyOnlyLinks"
                type="checkbox"
                checked={policy.enforce_company_only_links === 1}
                onChange={(e) =>
                  onPolicyChange({
                    ...policy,
                    enforce_company_only_links: e.target.checked ? 1 : 0,
                  })
                }
              />
            </label>

            <label className="flex items-center justify-between gap-3 rounded-xl border border-[#e7e7ea] px-3 py-2.5 text-xs">
              <span>
                <span className="block font-medium text-slate-800">
                  Confidential に動的透かしを強制
                </span>
                <span className="mt-0.5 block text-[0.625rem] text-slate-500">
                  機密区分のファイルをプレビュー・ダウンロードする際に閲覧者情報を焼き込みます。
                </span>
              </span>
              <input
                id="policy-require-watermark"
                name="requireWatermarkConfidential"
                type="checkbox"
                checked={policy.require_watermark_confidential === 1}
                onChange={(e) =>
                  onPolicyChange({
                    ...policy,
                    require_watermark_confidential: e.target.checked ? 1 : 0,
                  })
                }
              />
            </label>

            <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <legend className="px-1 text-xs font-semibold text-slate-700">
                共有リンク権限レベル (view / download / edit)
              </legend>

              <div className="space-y-1">
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-700">
                    編集共有リンク (edit) を許可
                  </span>
                  <input
                    id="policy-allow-shared-link-edit"
                    name="allowSharedLinkEdit"
                    {...NATIVE_SWITCH_ATTRS}
                    type="checkbox"
                    checked={policy.allow_shared_link_edit === 1}
                    onChange={(e) =>
                      onPolicyChange({
                        ...policy,
                        allow_shared_link_edit: e.target.checked ? 1 : 0,
                        allow_public_edit_links: e.target.checked
                          ? policy.allow_public_edit_links
                          : 0,
                      })
                    }
                  />
                </label>
                <p className="text-[0.6875rem] text-slate-500">
                  有効にすると Editor 以上がアップロード・上書き保存・WOPI
                  編集を許可する共有リンクを作成できます。削除・権限管理・共有管理は付与されません。
                </p>
              </div>

              <div className="space-y-1">
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-700">
                    Public (匿名) 編集リンクを許可（パスワード・期限必須）
                  </span>
                  <input
                    id="policy-allow-public-edit-links"
                    name="allowPublicEditLinks"
                    {...NATIVE_SWITCH_ATTRS}
                    type="checkbox"
                    checked={policy.allow_public_edit_links === 1}
                    disabled={policy.allow_shared_link_edit !== 1}
                    onChange={(e) =>
                      onPolicyChange({
                        ...policy,
                        allow_public_edit_links: e.target.checked ? 1 : 0,
                      })
                    }
                  />
                </label>
                <p className="text-[0.6875rem] text-amber-700">
                  匿名ユーザーが編集できる公開リンクを許可します。パスワードと有効期限の両方が必須です。編集共有リンク本体が無効な場合は適用されません。
                </p>
              </div>

              <div className="space-y-1">
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-700">
                    Viewer ロールによる表示専用共有リンク作成を許可
                  </span>
                  <input
                    id="policy-allow-viewer-share-links"
                    name="allowViewerShareLinks"
                    {...NATIVE_SWITCH_ATTRS}
                    type="checkbox"
                    checked={policy.allow_viewer_share_links === 1}
                    onChange={(e) =>
                      onPolicyChange({
                        ...policy,
                        allow_viewer_share_links: e.target.checked ? 1 : 0,
                      })
                    }
                  />
                </label>
                <p className="text-[0.6875rem] text-slate-500">
                  Viewer は表示専用 (view) リンクのみ作成できます。ダウンロード・編集リンクは作成できません。
                </p>
              </div>
            </fieldset>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                <span className="font-medium text-slate-700">
                  最大共有期限 (日)
                </span>
                <input
                  id="policy-max-link-expiration-days"
                  name="maxLinkExpirationDays"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  value={policy.max_link_expiration_days}
                  onChange={(e) =>
                    onPolicyChange({
                      ...policy,
                      max_link_expiration_days: Number.parseInt(
                        e.target.value || '30',
                        10
                      ),
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                />
              </label>

              {showLegacyFields && (
                <>
                  <label className="block text-xs">
                    <span className="font-medium text-slate-700">
                      AI 分類モード
                    </span>
                    <select
                      id="policy-ai-classification-mode"
                      name="aiClassificationMode"
                      value={policy.ai_classification_mode}
                      onChange={(e) =>
                        onPolicyChange({
                          ...policy,
                          ai_classification_mode: e.target
                            .value as AiClassificationMode,
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                    >
                      <option value="content_excerpt">
                        content_excerpt (本文先頭抽出)
                      </option>
                      <option value="metadata_only">
                        metadata_only (メタデータのみ)
                      </option>
                      <option value="disabled">disabled (停止)</option>
                    </select>
                  </label>

                  <label className="block text-xs">
                    <span className="font-medium text-slate-700">
                      ゴミ箱保持 (日)
                    </span>
                    <input
                      id="policy-trash-retention-days"
                      name="trashRetentionDays"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={3650}
                      value={policy.trash_retention_days}
                      onChange={(e) =>
                        onPolicyChange({
                          ...policy,
                          trash_retention_days: Number.parseInt(
                            e.target.value || '90',
                            10
                          ),
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                    />
                  </label>
                </>
              )}
            </div>

            <button
              type="submit"
              disabled={policySaving}
              className="h-8 w-full rounded-md bg-[#5e6ad2] text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {policySaving ? '保存中...' : 'ポリシーを保存'}
            </button>
          </div>
        </form>
      )}

      <details
        data-testid="shared-links-monitor-details"
        open={monitorOpen}
        onToggle={(event) => setMonitorOpen(event.currentTarget.open)}
        className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white"
      >
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-5 py-4 text-sm font-semibold text-slate-900">
          <span className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
            稼働中の外部・内部共有リンク監視
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
            {sharedLinks.length} 件
          </span>
        </summary>

        {sharedLinks.length === 0 ? (
          <div className="border-t border-[#f2f2f4] px-5 py-10 text-center text-xs text-slate-500">
            稼働中の共有リンクはありません
          </div>
        ) : (
          <div
            role="region"
            aria-label="稼働中の共有リンク監視"
            tabIndex={0}
            className="overflow-x-auto border-t border-[#f2f2f4]"
          >
            <table className="w-full text-left text-xs">
              <caption className="sr-only">稼働中の共有リンク監視</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2.5">
                    対象 / 発行者
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    スコープ / 状態
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    失敗試行 / DL数
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    緊急失効
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sharedLinks.map((link) => {
                  const hasAnomaly =
                    link.failed_password_attempts > 0 ||
                    Boolean(link.locked_until);
                  return (
                    <tr
                      key={link.id}
                      className={
                        hasAnomaly ? 'bg-red-50/60' : 'hover:bg-slate-50/70'
                      }
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">
                          {link.target_name ?? link.target_id}
                        </div>
                        <div className="text-[0.6875rem] text-slate-500">
                          {link.target_type} •{' '}
                          {link.creator_email ?? link.created_by}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[0.6875rem] text-slate-700">
                          {link.access_scope}
                        </span>
                        {link.locked_until && (
                          <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[0.625rem] font-semibold text-red-700">
                            LOCKED
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[0.6875rem] text-slate-600">
                        PW失敗: {link.failed_password_attempts} • DL:{' '}
                        {link.download_count}
                        {link.max_downloads ? `/${link.max_downloads}` : ''}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => onEmergencyRevoke(link.id)}
                          className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[0.6875rem] font-semibold text-red-600 hover:bg-red-50"
                        >
                          緊急失効
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
