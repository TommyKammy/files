'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mail,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { GuestOtpForm } from '@/components/guest/GuestOtpForm';
import {
  acceptGuestInvitation,
  fetchGuestInviteMeta,
  verifyGuestOtp,
} from '@/lib/files-api';
import { guestAuthErrorMessage } from '@/lib/guest-auth-messages';
import type { GuestInviteMeta } from '@/types/files';

export function GuestAcceptPanel() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';

  const [meta, setMeta] = useState<GuestInviteMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [stage, setStage] = useState<'accept' | 'otp' | 'done'>('accept');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    if (!token) {
      setMetaError('招待トークンがありません。招待メールの URL から開いてください。');
      setMetaLoading(false);
      return;
    }
    setMetaLoading(true);
    try {
      const response = await fetchGuestInviteMeta(token);
      setMeta(response.invitation);
      setMetaError(null);
    } catch (err) {
      setMetaError(
        guestAuthErrorMessage(
          err,
          '招待情報の読み込みに失敗しました。時間をおいて再試行してください。'
        )
      );
    } finally {
      setMetaLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  async function handleAccept(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await acceptGuestInvitation(token);
      setEmail(response.email);
      setStage('otp');
      setNotice(
        `${response.emailMasked} 宛に 6 桁の認証コードを送信しました。`
      );
    } catch (err) {
      setError(
        guestAuthErrorMessage(
          err,
          '招待の承諾に失敗しました。時間をおいて再試行してください。'
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
      setStage('done');
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

  if (metaLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
        招待情報を確認中...
      </div>
    );
  }

  if (metaError || !meta) {
    return (
      <div className="space-y-3" data-testid="guest-accept-unavailable">
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{metaError ?? '招待情報を確認できませんでした。'}</span>
        </div>
        <Link href="/guest/login" className="text-xs font-medium text-[#5e6ad2] hover:underline">
          ゲストログインへ
        </Link>
      </div>
    );
  }

  if (!meta.valid && meta.status !== 'pending') {
    const message = meta.used
      ? 'この招待は使用済みです。招待 URL は 1 回だけ有効です。'
      : meta.revoked
        ? 'この招待は管理者によって取り消されています。'
        : meta.expired
          ? 'この招待は有効期限が切れています。'
          : 'この招待は現在承諾できません。';
    return (
      <div className="space-y-3" data-testid="guest-accept-unavailable">
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">{message}</p>
            {meta.reason && (
              <p className="mt-0.5 text-[0.6875rem]">理由コード: {meta.reason}</p>
            )}
          </div>
        </div>
        <Link href="/guest/login" className="text-xs font-medium text-[#5e6ad2] hover:underline">
          ゲストログインへ
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="guest-accept-panel">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3 text-[0.75rem]">
        <dt className="text-[#55565a]">テナント</dt>
        <dd className="font-medium text-[#111214]">{meta.tenantName}</dd>
        <dt className="text-[#55565a]">招待先</dt>
        <dd className="font-medium text-[#111214]">{meta.emailMasked}</dd>
        <dt className="text-[#55565a]">ゲスト名</dt>
        <dd className="text-[#111214]">{meta.displayName}</dd>
        <dt className="text-[#55565a]">外部組織</dt>
        <dd className="text-[#111214]">{meta.externalOrg ?? '未設定'}</dd>
        <dt className="text-[#55565a]">共有対象</dt>
        <dd className="text-[#111214]">{meta.targetName ?? '共有フォルダ'}</dd>
        <dt className="text-[#55565a]">ロール</dt>
        <dd className="font-mono text-[0.6875rem] text-[#111214]">{meta.role}</dd>
        <dt className="text-[#55565a]">招待者</dt>
        <dd className="text-[#111214]">{meta.invitedByName ?? '管理者'}</dd>
        <dt className="text-[#55565a]">有効期限</dt>
        <dd className="text-[#111214]">
          {new Date(meta.expiresAt).toLocaleString('ja-JP')}
        </dd>
      </dl>

      {(meta.branding?.orgName?.trim() ||
        meta.branding?.contactInfo?.trim() ||
        meta.branding?.footerNote?.trim()) && (
        <div
          data-testid="guest-branding"
          className="space-y-1 rounded-xl border border-[#e7e7ea] bg-white px-3 py-2 text-[0.6875rem] text-[#55565a]"
        >
          {meta.branding?.orgName?.trim() && (
            <p className="break-words font-medium text-[#111214]">
              {meta.branding.orgName.trim()}
            </p>
          )}
          {meta.branding?.contactInfo?.trim() && (
            <p className="whitespace-pre-wrap break-words">
              お問い合わせ: {meta.branding.contactInfo.trim()}
            </p>
          )}
          {meta.branding?.footerNote?.trim() && (
            <p className="whitespace-pre-wrap break-words">
              {meta.branding.footerNote.trim()}
            </p>
          )}
        </div>
      )}

      {stage === 'accept' && (
        <form onSubmit={handleAccept} className="space-y-3" noValidate>
          <p className="flex items-start gap-2 rounded-xl bg-blue-50 px-3 py-2 text-[0.6875rem] text-blue-900">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            承諾すると、この招待は使用済みになり、メールに 6 桁の認証コードが届きます。
          </p>
          <button
            type="submit"
            data-testid="guest-accept-submit"
            disabled={busy || !meta.canAccept}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.8125rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            <UserCheck className="h-4 w-4" />
            招待を承諾して認証コードを送信
          </button>
        </form>
      )}

      {stage === 'otp' && (
        <div className="space-y-3">
          <label
            htmlFor="guest-accept-email"
            className="block text-[0.75rem] font-medium text-[#111214]"
          >
            招待先メールアドレス
          </label>
          <input
            id="guest-accept-email"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            readOnly
            value={email}
            aria-describedby="guest-accept-email-hint"
            className="h-9 w-full rounded-md border border-[#d7d7dc] bg-[#f2f2f4] px-2.5 text-[0.8125rem] text-[#3c3f46]"
          />
          <p id="guest-accept-email-hint" className="text-[0.625rem] text-[#55565a]">
            招待先のメールアドレスに認証コードを送信しました。
          </p>
          <GuestOtpForm
            email={email}
            busy={busy}
            submitLabel="認証してワークスペースへ"
            onSubmit={handleVerifyOtp}
          />
          <p className="text-center text-[0.625rem] text-[#55565a]">
            コードが届かない場合は{' '}
            <Link href="/guest/login" className="font-medium text-[#5e6ad2] hover:underline">
              ゲストログイン
            </Link>{' '}
            から再送できます。
          </p>
        </div>
      )}

      {stage === 'done' && (
        <p className="flex items-center gap-2 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          認証に成功しました。
        </p>
      )}

      <div aria-live="polite" className="space-y-2">
        {notice && stage !== 'done' && (
          <p role="status" data-testid="guest-accept-notice" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800">
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" data-testid="guest-accept-error" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
