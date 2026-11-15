import Link from 'next/link';
import { HomeSessionControl } from '@/components/SignInCard';

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#F8FAFC] px-6">
      <div className="max-w-lg w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-[#131B2E] flex items-center justify-center text-white font-bold">
            F
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Files</h1>
            <p className="text-xs text-slate-500">
              Enterprise File Governance Platform
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-600 leading-relaxed">
          Cloudflare Workers / D1 / R2 / Queues / Workers AI 基盤上で動作する
          セキュア・ファイル共有＆ガバナンスワークスペースです。
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link
            href="/workspace"
            className="flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition"
          >
            ワークスペースを開く
          </Link>
          <Link
            href="/admin"
            className="flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
          >
            ガバナンス管理
          </Link>
        </div>

        <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-xs text-slate-600 space-y-1.5">
          <div>• OIDC SSO セッション / SCIM 2.0 連携対応</div>
          <div>• ⌘K FTS5 横断検索・AI 機密自動分類・動的透かしプレビュー</div>
          <div>
            • <a href="/auth/login?returnTo=/workspace" className="text-blue-600 hover:underline font-medium">SSO で直接サインイン</a>
          </div>
        </div>

        <HomeSessionControl />
      </div>
    </main>
  );
}
