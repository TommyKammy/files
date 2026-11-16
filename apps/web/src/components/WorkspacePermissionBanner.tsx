'use client';

import { Eye, Lock, UploadCloud } from 'lucide-react';
import {
  ROLE_CAPABILITY_CHIPS,
  ROLE_META,
  isAdvancedResourceRole,
} from '@/lib/capabilities';
import type { Capability, ResourceRole } from '@/types/files';

const ROLE_SUMMARY: Partial<
  Record<
    ResourceRole,
    { allowed: string; restricted: string; uploadOnly?: boolean }
  >
> = {
  uploader: {
    allowed:
      'フォルダの閲覧・サブフォルダ作成・新規ファイルのアップロードができます。',
    restricted:
      'ファイル一覧・プレビュー・ダウンロード・版履歴・WOPI 編集・コピー・名前変更・移動・削除・共有・権限管理・機密区分変更はすべて無効です。',
    uploadOnly: true,
  },
  previewer_uploader: {
    allowed:
      'フォルダの閲覧・画面プレビュー・新規ファイルのアップロード・サブフォルダ作成ができます。',
    restricted:
      'ダウンロード・既存ファイルの新版アップロード・WOPI 編集・コピー・名前変更・移動・削除・共有・権限管理・機密区分変更はできません。',
  },
  viewer_uploader: {
    allowed:
      '閲覧・ダウンロード・WOPI 編集・新規/新版アップロード・サブフォルダ作成・コピー・表示専用共有リンクの作成ができます。',
    restricted:
      '名前変更・移動・削除・権限管理・機密区分変更・共有リンクの管理（失効）はできません。',
  },
  previewer: {
    allowed: 'フォルダの閲覧と画面プレビューができます。',
    restricted:
      'ダウンロード・アップロード・編集・コピー・名前変更・移動・削除・共有・権限管理・機密区分変更はできません。',
  },
};

export function WorkspacePermissionBanner({
  role,
  capabilities,
}: {
  role: ResourceRole;
  capabilities?: Capability[];
}) {
  const summary = ROLE_SUMMARY[role];
  if (!summary) return null;

  const roleMeta = ROLE_META[role];
  const chips = ROLE_CAPABILITY_CHIPS[role] ?? [];
  const advanced = isAdvancedResourceRole(role);
  const uploadOnly = summary.uploadOnly === true;

  return (
    <section
      aria-label="実効ロールと操作範囲"
      data-testid="workspace-permission-banner"
      data-effective-role={role}
      className={`min-w-0 rounded-xl border p-3.5 ${
        uploadOnly
          ? 'border-amber-300 bg-amber-50'
          : advanced
            ? 'border-indigo-200 bg-indigo-50/80'
            : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-current/20 bg-white px-2.5 py-1 text-[0.6875rem] font-semibold text-slate-800">
          {uploadOnly ? (
            <UploadCloud className="h-3.5 w-3.5 text-amber-600" />
          ) : (
            <Eye className="h-3.5 w-3.5 text-indigo-600" />
          )}
          実効ロール: {roleMeta.label}
        </span>
        <ul
          aria-label={`${roleMeta.label} の権限`}
          className="flex min-w-0 flex-wrap gap-1"
        >
          {chips.map((chip) => (
            <li
              key={chip}
              className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[0.625rem] leading-4 text-slate-600"
            >
              {chip}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-2 grid min-w-0 grid-cols-1 gap-1.5 text-[0.6875rem] leading-relaxed sm:grid-cols-2">
        <p className="min-w-0 break-words text-slate-700">
          <span className="font-semibold text-emerald-700">許可: </span>
          {summary.allowed}
        </p>
        <p className="min-w-0 break-words text-slate-700">
          <span className="inline-flex items-center gap-1 font-semibold text-rose-700">
            <Lock className="h-3 w-3" />
            制限:{' '}
          </span>
          {summary.restricted}
        </p>
      </div>

      {uploadOnly && (
        <p className="mt-2 break-words rounded-lg border border-amber-200 bg-white/70 px-2.5 py-1.5 text-[0.6875rem] font-medium text-amber-900">
          Uploader 権限では、アップロードしたファイルはこの一覧に表示されません。内容の確認・ダウンロードが必要な場合は、Owner に Viewer 以上の権限を依頼してください。
        </p>
      )}

      {capabilities && capabilities.length === 0 && (
        <p className="mt-2 text-[0.625rem] text-slate-500">
          サーバーから権限情報を取得できなかったため、ロール既定値で表示しています。
        </p>
      )}
    </section>
  );
}
