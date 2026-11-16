'use client';

import { Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  OTP_INPUT_ATTRIBUTES,
  isValidOtp,
  sanitizeOtpInput,
} from '@/lib/guest-policy';

export function GuestOtpForm({
  email,
  busy,
  submitLabel = '認証してサインイン',
  onSubmit,
}: {
  email: string;
  busy: boolean;
  submitLabel?: string;
  onSubmit: (otp: string) => void | Promise<void>;
}) {
  const [otp, setOtp] = useState('');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const invalid = touched && !isValidOtp(otp);

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!isValidOtp(otp)) {
          inputRef.current?.focus();
          return;
        }
        void onSubmit(otp);
      }}
    >
      <div>
        <label
          htmlFor="guest-otp"
          className="mb-1 block text-[0.75rem] font-medium text-[#111214]"
        >
          6 桁の認証コード
        </label>
        <p id="guest-otp-hint" className="mb-1.5 text-[0.6875rem] text-[#55565a]">
          {email} 宛に送信した 6 桁のコードを入力してください。コードは 10 分間・1 回限り有効です。
        </p>
        <input
          {...OTP_INPUT_ATTRIBUTES}
          ref={inputRef}
          id="guest-otp"
          name="otp"
          data-testid="guest-otp-input"
          required
          autoFocus
          value={otp}
          disabled={busy}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby={
            invalid ? 'guest-otp-hint guest-otp-error' : 'guest-otp-hint'
          }
          onChange={(event) => setOtp(sanitizeOtpInput(event.target.value))}
          onBlur={() => setTouched(true)}
          className="field-input h-11 w-full rounded-md border border-[#d7d7dc] bg-white px-3 font-mono text-[1.125rem] tracking-[0.35em] text-[#111214]"
        />
        <p
          id="guest-otp-error"
          data-testid="guest-otp-error"
          className={`mt-1 text-[0.6875rem] text-red-700 ${
            invalid ? 'block' : 'hidden'
          }`}
        >
          エラー: 6 桁の数字を入力してください。
        </p>
      </div>
      <button
        type="submit"
        data-testid="guest-otp-submit"
        disabled={busy}
        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.8125rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {submitLabel}
      </button>
    </form>
  );
}
