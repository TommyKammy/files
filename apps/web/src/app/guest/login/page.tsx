import { GuestLoginPanel } from '@/components/guest/GuestLoginPanel';

export default function GuestLoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#efeff1] px-4 py-10 text-slate-900">
      <section className="w-full max-w-md rounded-2xl border border-[#e7e7ea] bg-white p-6 shadow-sm">
        <p className="mb-1 text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-[#5e6ad2]">
          External Guest
        </p>
        <h1 className="text-[1.125rem] font-semibold tracking-[-0.01em] text-[#111214]">
          外部ゲストのサインイン
        </h1>
        <p className="mb-4 mt-1 text-[0.75rem] text-[#55565a]">
          招待済みのメールアドレスに 6 桁のワンタイムコードを送信します。
        </p>
        <GuestLoginPanel />
      </section>
    </main>
  );
}
