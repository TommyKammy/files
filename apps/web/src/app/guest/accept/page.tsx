import { Suspense } from 'react';
import { GuestAcceptPanel } from '@/components/guest/GuestAcceptPanel';

export default function GuestAcceptPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#efeff1] px-4 py-10 text-slate-900">
      <section className="w-full max-w-lg rounded-2xl border border-[#e7e7ea] bg-white p-6 shadow-sm">
        <p className="mb-1 text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-[#5e6ad2]">
          External Guest
        </p>
        <h1 className="text-[1.125rem] font-semibold tracking-[-0.01em] text-[#111214]">
          外部ゲスト招待の承諾
        </h1>
        <p className="mb-4 mt-1 text-[0.75rem] text-[#55565a]">
          招待内容を確認し、メールに届く 6 桁の認証コードでサインインしてください。
        </p>
        <Suspense
          fallback={
            <div className="text-sm text-slate-500">招待情報を確認中...</div>
          }
        >
          <GuestAcceptPanel />
        </Suspense>
        <p className="mt-5 border-t border-[#e7e7ea] pt-3 text-[0.625rem] text-[#55565a]">
          この招待 URL は 1 回だけ有効です。心当たりがない場合は閉じてください。
        </p>
      </section>
    </main>
  );
}
