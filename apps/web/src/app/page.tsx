import Link from 'next/link';
import { HomeSessionControl } from '@/components/SignInCard';

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#efeff1] px-6">
      <div className="max-w-lg w-full rounded-xl border border-[#e7e7ea] bg-white p-7 shadow-xs space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-[#5e6ad2] flex items-center justify-center text-white font-bold">
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
            className="flex items-center justify-center h-9 rounded-md bg-[#5e6ad2] px-4 text-[0.8125rem] font-medium text-white transition hover:bg-[#4f5ac2]"
          >
            ワークスペースを開く
          </Link>
          <Link
            href="/admin"
            className="flex items-center justify-center h-9 rounded-md border border-[#e1e1e4] bg-white px-4 text-[0.8125rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            ガバナンス管理
          </Link>
        </div>

        <div className="rounded-lg border border-[#e7e7ea] bg-[#f9f9fa] p-4 text-[0.75rem] text-[#55565a] space-y-1.5">
          <div>• OIDC SSO セッション / SCIM 2.0 連携対応</div>
          <div>• ⌘K FTS5 横断検索・AI 機密自動分類・動的透かしプレビュー</div>
          <div>
            • <a href="/auth/login?returnTo=/workspace" className="text-[#4f5ac2] hover:underline font-medium">SSO で直接サインイン</a>
          </div>
        </div>

        <HomeSessionControl />
      </div>
    </main>
  );
}
