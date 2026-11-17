'use client';

import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { parseTosMarkdownBlocks } from '@/lib/admin-compliance';
import type { TenantBranding, TosStatus } from '@/types/files';

/**
 * Blocking ToS acceptance surface.
 *
 * The tenant policy is rendered through a tiny markdown subset that only emits
 * React text nodes. No HTML is ever injected, so a tenant administrator cannot
 * store script/event-handler markup that executes for members or guests.
 */
export function TosAcceptanceModal({
  tos,
  branding,
  accepting = false,
  error = null,
  onAccept,
}: {
  tos: TosStatus | null;
  branding: TenantBranding | null;
  accepting?: boolean;
  error?: string | null;
  onAccept: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const checkboxId = useId();
  const title = tos?.title?.trim() || '利用規約';
  const version = tos?.version ?? 1;
  const blocks = parseTosMarkdownBlocks(tos?.bodyMarkdown ?? '');
  const orgName = branding?.orgName?.trim() || null;
  const contactInfo = branding?.contactInfo?.trim() || null;
  const footerNote = branding?.footerNote?.trim() || null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="tos-acceptance-heading"
        aria-describedby="tos-acceptance-description"
        data-testid="tos-acceptance-modal"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-slate-100 px-6 py-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eef0fc] text-[#5e6ad2]">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-[#5e6ad2]">
              {orgName ?? 'Files'} — 利用規約 v{version}
            </p>
            <h2
              id="tos-acceptance-heading"
              className="mt-0.5 break-words text-base font-semibold text-slate-900"
            >
              {title}
            </h2>
            <p
              id="tos-acceptance-description"
              className="mt-1 text-[0.6875rem] leading-relaxed text-slate-600"
            >
              ワークスペースと共有アイテムを利用するには、最新の利用規約への同意が必要です。
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {blocks.length === 0 ? (
            <p className="whitespace-pre-wrap break-words text-[0.8125rem] leading-relaxed text-slate-700">
              管理者が本文を設定していません。同意して続行してください。
            </p>
          ) : (
            <div className="space-y-3 text-[0.8125rem] leading-relaxed text-slate-700">
              {blocks.map((block, index) => {
                if (block.kind === 'heading') {
                  const headingClass =
                    block.level === 1
                      ? 'text-sm font-semibold text-slate-900'
                      : block.level === 2
                        ? 'text-[0.8125rem] font-semibold text-slate-900'
                        : 'text-[0.75rem] font-semibold text-slate-800';
                  return (
                    <p
                      key={`heading-${index}`}
                      className={headingClass}
                    >
                      {block.text}
                    </p>
                  );
                }
                if (block.kind === 'bullet') {
                  return (
                    <div
                      key={`bullet-${index}`}
                      className="flex gap-2 break-words"
                    >
                      <span aria-hidden="true" className="text-[#5e6ad2]">
                        •
                      </span>
                      <span className="whitespace-pre-wrap">{block.text}</span>
                    </div>
                  );
                }
                return (
                  <p
                    key={`paragraph-${index}`}
                    className="whitespace-pre-wrap break-words"
                  >
                    {block.text}
                  </p>
                );
              })}
            </div>
          )}
        </div>

        <footer className="space-y-3 border-t border-slate-100 bg-slate-50 px-6 py-4">
          <label
            htmlFor={checkboxId}
            className="flex cursor-pointer items-start gap-2.5 text-[0.75rem] leading-relaxed text-slate-700"
          >
            <input
              id={checkboxId}
              data-testid="tos-acceptance-checkbox"
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-[#5e6ad2]"
            />
            <span className="break-words">
              「{title}」の内容を確認し、最新版 (v{version}) に同意します。
            </span>
          </label>

          {contactInfo && (
            <p className="whitespace-pre-wrap break-words text-[0.6875rem] text-slate-600">
              お問い合わせ: {contactInfo}
            </p>
          )}
          {footerNote && (
            <p
              data-testid="tos-branding-footer"
              className="whitespace-pre-wrap break-words text-[0.625rem] leading-relaxed text-slate-500"
            >
              {footerNote}
            </p>
          )}

          {error && (
            <p
              role="alert"
              data-testid="tos-acceptance-error"
              className="break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[0.625rem] text-slate-500">
              同意すると記録日時・バージョン・接続元が監査ログに保存されます。
            </p>
            <button
              type="button"
              data-testid="tos-acceptance-submit"
              disabled={!checked || accepting}
              onClick={onAccept}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#5e6ad2] px-4 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {accepting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{accepting ? '記録中...' : '同意して続行'}</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
