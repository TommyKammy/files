'use client';

import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiClientError, fetchGuestSummary } from '@/lib/files-api';
import { formatGuestSummary, type GuestSummaryView } from '@/lib/guest-collaboration';
import type { GuestSummaryResponse } from '@/types/files';

/**
 * Inline guest detail card (no nested modal): keeps focus inside the existing
 * permissions dialog while showing effective permissions, inheritance source,
 * shared items, last login, inviter and expiry.
 */
export function GuestSummaryCard({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState<GuestSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSummary(null);
    fetchGuestSummary(userId)
      .then((response) => {
        if (!cancelled) setSummary(response);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'ゲスト詳細の取得に失敗しました'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  let view: GuestSummaryView | null = null;
  if (summary) {
    try {
      view = formatGuestSummary(summary);
    } catch {
      view = null;
    }
  }

  return (
    <section
      aria-labelledby="guest-summary-heading"
      data-testid="guest-detail-card"
      className="min-w-0 space-y-3 rounded-xl border border-sky-200 bg-sky-50/60 p-4"
    >
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id="guest-summary-heading"
            className="break-words text-xs font-semibold text-sky-950"
          >
            外部ゲスト詳細
          </h3>
          <p className="mt-0.5 break-words text-[0.6875rem] leading-relaxed text-sky-900">
            実効権限・継承元・共有アイテム・最終ログイン・招待者・有効期限を表示します。
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="ゲスト詳細を閉じる"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sky-900 transition hover:bg-sky-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {loading ? (
        <p
          role="status"
          className="flex items-center gap-2 text-[0.6875rem] text-sky-900"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ゲスト情報を読み込み中...
        </p>
      ) : error ? (
        <p
          role="alert"
          data-testid="guest-detail-error"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-800"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : view ? (
        <div className="space-y-3" data-testid="guest-detail-content">
          <div className="min-w-0 rounded-lg border border-sky-100 bg-white p-3">
            <dl className="grid min-w-0 grid-cols-1 gap-2 text-[0.6875rem] leading-relaxed sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">表示名</dt>
                <dd className="break-words text-slate-900">
                  {view.guest.displayName}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">メール</dt>
                <dd className="break-all text-slate-900">{view.guest.email}</dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">外部組織</dt>
                <dd
                  className="break-words text-slate-900"
                  data-testid="guest-detail-external-org"
                >
                  {view.guest.externalOrgLabel}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">状態</dt>
                <dd className="text-slate-900">{view.guest.statusLabel}</dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">アカウント有効期限</dt>
                <dd
                  className="break-words text-slate-900"
                  data-testid="guest-detail-expiry"
                >
                  {view.guest.expiresLabel}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">最終ログイン</dt>
                <dd
                  className="break-words text-slate-900"
                  data-testid="guest-detail-last-login"
                >
                  {view.guest.lastLoginLabel}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">招待者</dt>
                <dd
                  className="break-words text-slate-900"
                  data-testid="guest-detail-inviter"
                >
                  {view.guest.invitedByLabel}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold text-slate-700">サマリ</dt>
                <dd className="break-words text-slate-900">{view.summaryLine}</dd>
              </div>
            </dl>
          </div>

          <div className="min-w-0 space-y-1.5">
            <h4 className="text-[0.6875rem] font-semibold text-sky-950">
              実効権限と継承元
            </h4>
            {view.effectivePermissions.length === 0 ? (
              <p className="text-[0.6875rem] text-slate-600">
                実効権限はありません。
              </p>
            ) : (
              <ul
                className="space-y-1.5"
                data-testid="guest-detail-effective-permissions"
              >
                {view.effectivePermissions.map((permission) => (
                  <li
                    key={permission.key}
                    className="min-w-0 rounded-lg border border-sky-100 bg-white px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-800"
                  >
                    <p className="break-words font-medium text-slate-900">
                      {permission.targetLabel}
                    </p>
                    <p className="break-words">
                      {permission.roleLabel}（{permission.sourceLabel}）／ 合成:{' '}
                      {permission.synthesizedLabel}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 space-y-1.5">
            <h4 className="text-[0.6875rem] font-semibold text-sky-950">
              共有アイテム
            </h4>
            {view.sharedItems.length === 0 ? (
              <p className="text-[0.6875rem] text-slate-600">
                共有アイテムはありません。
              </p>
            ) : (
              <ul className="space-y-1.5" data-testid="guest-detail-shared-items">
                {view.sharedItems.map((item) => (
                  <li
                    key={item.key}
                    className="min-w-0 rounded-lg border border-sky-100 bg-white px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-800"
                  >
                    <p className="break-words font-medium text-slate-900">
                      {item.kindLabel}: {item.name}
                    </p>
                    <p className="break-words">{item.pathLabel}</p>
                    <p className="break-words text-slate-600">
                      機密区分: {item.classificationLabel} / 実効ロール:{' '}
                      {item.roleLabel}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 space-y-1.5">
            <h4 className="text-[0.6875rem] font-semibold text-sky-950">
              招待履歴
            </h4>
            {view.invitations.length === 0 ? (
              <p className="text-[0.6875rem] text-slate-600">
                招待履歴はありません。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {view.invitations.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="min-w-0 rounded-lg border border-sky-100 bg-white px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-800"
                  >
                    <p className="break-words font-medium text-slate-900">
                      {invitation.targetName} / {invitation.roleLabel} /{' '}
                      {invitation.statusLabel}
                    </p>
                    <p className="break-words text-slate-600">
                      有効期限: {invitation.expiresLabel}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="text-[0.6875rem] text-slate-600">
          表示できるゲスト情報がありません。
        </p>
      )}
    </section>
  );
}
