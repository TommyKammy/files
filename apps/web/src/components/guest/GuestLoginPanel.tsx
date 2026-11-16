'use client';

import { AlertTriangle, Loader2, Mail, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { GuestOtpForm } from '@/components/guest/GuestOtpForm';
import { requestGuestOtp, verifyGuestOtp } from '@/lib/files-api';
import { guestAuthErrorMessage } from '@/lib/guest-auth-messages';

export function GuestLoginPanel() {
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState<'email' | 'otp'>('email');
  const [emailTouched, setEmailTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const emailInvalid = emailTouched && !emailValid;

  async function handleRequestOtp(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setEmailTouched(true);
    if (!emailValid) {
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await requestGuestOtp(email);
      setEmail(response.email);
      setStage('otp');
      setNotice(`${response.emailMasked} 宛に 6 桁の認証コードを送信しました。`);
    } catch (err) {
      setError(
        guestAuthErrorMessage(
          err,
          '認証コードの送信に失敗しました。時間をおいて再試行してください。'
        )
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(otp: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await verifyGuestOtp(email, otp);
      setNotice('認証に成功しました。ワークスペースへ移動します。');
      window.location.assign('/workspace');
    } catch (err) {
      setError(
        guestAuthErrorMessage(
          err,
          '認証コードの確認に失敗しました。時間をおいて再試行してください。'
        )
      );
      setBusy(false);
    }
  }

  if (stage === 'otp') {
    return (
      <div className="space-y-4" data-testid="guest-login-otp-stage">
        <div className="space-y-3">
          <label
            htmlFor="guest-login-email"
            className="block text-[0.75rem] font-medium text-[#111214]"
          >
            ゲストのメールアドレス
          </label>
          <input
            id="guest-login-email"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            readOnly
            value={email}
            className="h-9 w-full rounded-md border border-[#d7d7dc] bg-[#f2f2f4] px-2.5 text-[0.8125rem] text-[#3c3f46]"
          />
        </div>
        <GuestOtpForm
          email={email}
          busy={busy}
          submitLabel="認証してサインイン"
          onSubmit={handleVerifyOtp}
        />
        <button
          type="button"
          onClick={() => {
            setStage('email');
            setError(null);
            setNotice(null);
          }}
          className="text-[0.6875rem] font-medium text-[#5e6ad2] hover:underline"
        >
          別のメールアドレスでやり直す
        </button>
        <div aria-live="polite" className="space-y-2">
          {notice && (
            <p role="status" data-testid="guest-login-notice" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800">
              <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" data-testid="guest-login-error" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="guest-login-panel">
      <form onSubmit={handleRequestOtp} className="space-y-3" noValidate>
        <div>
          <label
            htmlFor="guest-login-email"
            className="mb-1 block text-[0.75rem] font-medium text-[#111214]"
          >
            ゲストのメールアドレス
          </label>
          <p id="guest-login-email-hint" className="mb-1.5 text-[0.6875rem] text-[#55565a]">
            招待された外部ゲストのメールアドレスを入力してください。6 桁の認証コードを送信します。
          </p>
          <input
            ref={emailRef}
            id="guest-login-email"
            data-testid="guest-login-email"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            inputMode="email"
            enterKeyHint="send"
            required
            value={email}
            disabled={busy}
            aria-invalid={emailInvalid ? 'true' : undefined}
            aria-describedby={
              emailInvalid
                ? 'guest-login-email-hint guest-login-email-error'
                : 'guest-login-email-hint'
            }
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setEmailTouched(true)}
            className="field-input h-9 w-full rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.8125rem] text-[#111214]"
          />
          <p
            id="guest-login-email-error"
            data-testid="guest-login-email-error"
            className={`mt-1 text-[0.6875rem] text-red-700 ${
              emailInvalid ? 'block' : 'hidden'
            }`}
          >
            エラー: you@example.com の形式で入力してください。
          </p>
        </div>
        <button
          type="submit"
          data-testid="guest-login-submit"
          disabled={busy}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.8125rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          認証コードを送信
        </button>
      </form>

      <p className="flex items-start gap-2 rounded-xl bg-[#f2f2f4] px-3 py-2 text-[0.625rem] text-[#55565a]">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        社内メンバーの方は{' '}
        <a href="/auth/login" className="font-medium text-[#5e6ad2] hover:underline">
          SSO サインイン
        </a>{' '}
        をご利用ください。
      </p>
      <p className="text-center text-[0.625rem] text-[#55565a]">
        招待メールをお持ちの方は{' '}
        <Link href="/guest/accept" className="font-medium text-[#5e6ad2] hover:underline">
          招待の承諾
        </Link>{' '}
        から開始してください。
      </p>

      <div aria-live="polite" className="space-y-2">
        {notice && (
          <p role="status" data-testid="guest-login-notice" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800">
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" data-testid="guest-login-error" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
