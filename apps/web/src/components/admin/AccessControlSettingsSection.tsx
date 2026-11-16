'use client';

import {
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TenantPolicyRow } from '@/types/files';

/**
 * Native checkbox rendered as a switch. React's HTML typings predate the
 * HTML `switch` attribute, so the attribute is spread through an explicit
 * input-props cast while remaining a real native checkbox in the DOM.
 */
const NATIVE_SWITCH_ATTRS = {
  switch: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

function readAdvancedRolesEnabled(policy: TenantPolicyRow | null): boolean {
  if (!policy) return false;
  if (typeof policy.advancedRolesEnabled === 'boolean') {
    return policy.advancedRolesEnabled;
  }
  return policy.advanced_roles_enabled === 1;
}

export function AccessControlSettingsSection({
  policy,
  saving,
  error,
  notice,
  onSave,
  onDirtyChange,
}: {
  policy: TenantPolicyRow | null;
  saving: boolean;
  error: string | null;
  notice: string | null;
  onSave: (enabled: boolean) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const persisted = readAdvancedRolesEnabled(policy);
  const [desiredEnabled, setDesiredEnabled] = useState(persisted);
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (dirtyRef.current) return;
    setDesiredEnabled(readAdvancedRolesEnabled(policy));
  }, [policy]);

  function updateDirty(next: boolean) {
    dirtyRef.current = next;
    setDirty(next);
    onDirtyChange(next);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !policy) return;
    setLocalError(null);
    const ok = await onSave(desiredEnabled);
    if (ok) updateDirty(false);
  }

  const statusId = 'policy-advanced-roles-status';
  const descriptionId = 'policy-advanced-roles-description';
  const feedback = localError ?? error;

  return (
    <section
      aria-labelledby="access-control-heading"
      className="grid grid-cols-1 gap-6 xl:grid-cols-3"
    >
      <div className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white xl:col-span-2">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" />
            <h2
              id="access-control-heading"
              className="text-sm font-semibold text-slate-900"
            >
              アクセス制御
            </h2>
          </div>
          <p className="mt-1 text-[0.6875rem] text-slate-500">
            高度ロール (Uploader / Previewer + Uploader / Viewer + Uploader)
            のテナントポリシーと、次期フェーズのアクセス制御予定を管理します。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-slate-700">
              高度ロール (Advanced Roles) 有効化スイッチ
            </legend>

            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
              <label
                htmlFor="policy-advanced-roles-enabled"
                className="flex cursor-pointer items-start gap-3 text-xs"
              >
                <input
                  {...NATIVE_SWITCH_ATTRS}
                  id="policy-advanced-roles-enabled"
                  name="advancedRolesEnabled"
                  type="checkbox"
                  checked={desiredEnabled}
                  disabled={!policy || saving}
                  aria-describedby={descriptionId}
                  onChange={(event) => {
                    setDesiredEnabled(event.target.checked);
                    setLocalError(null);
                    updateDirty(true);
                  }}
                  onKeyDown={(event) => {
                    // Native checkboxes toggle on Space; add Enter for parity
                    // with the switch pattern expected by the admin UX.
                    if (event.key !== 'Enter' || !policy || saving) return;
                    event.preventDefault();
                    setDesiredEnabled((prev) => !prev);
                    setLocalError(null);
                    updateDirty(true);
                  }}
                  className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">
                    投稿系ロールをフォルダで付与可能にする
                  </span>
                  <span
                    id={descriptionId}
                    className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
                  >
                    既定は無効です。無効時は新しい高度ロール付与をブロックし、既存の付与は変更・削除するまで保持します。
                    高度ロールはフォルダ専用で、ファイルには付与できません。
                  </span>
                </span>
              </label>

              <div className="flex shrink-0 items-center gap-2 sm:pl-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${
                    persisted
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {persisted ? '有効' : '無効'}
                </span>
                <button
                  type="submit"
                  disabled={!policy || saving || !dirty}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>{saving ? '保存中...' : '変更を保存'}</span>
                </button>
              </div>
            </div>
          </fieldset>

          <div
            id={statusId}
            aria-live="assertive"
            aria-atomic="true"
            className="min-h-0"
          >
            {feedback && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{feedback}</span>
              </div>
            )}
            {!feedback && notice && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}
            {!feedback && !notice && dirty && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  未保存の変更があります。「変更を保存」で
                  {desiredEnabled ? '有効化' : '無効化'}を適用してください。
                </span>
              </div>
            )}
          </div>

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
        </form>
      </div>

      <div className="rounded-lg border border-dashed border-[#cfd3ea] bg-[#f4f5fb] p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" />
          <h2 className="text-sm font-semibold text-slate-900">
            アクセス制御の拡張（次期フェーズ）
          </h2>
        </div>
        <p className="mt-2 text-[0.6875rem] leading-relaxed text-slate-600">
          オープン / クローズド構成・ルートフォルダ作成ポリシー（次期フェーズ
          <span className="font-mono"> [P9-3] </span>
          実装予定）
        </p>
        <p className="mt-3 rounded-lg border border-[#d9dcef] bg-white px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-500">
          現在のフェーズでは、テナント全体の高度ロール可否と既存の RBAC
          ガードレールのみを管理します。ルートフォルダの作成許可やオープン /
          クローズド構成の切り替えは、[P9-3] でこのセクションに追加されます。
        </p>
      </div>
    </section>
  );
}
