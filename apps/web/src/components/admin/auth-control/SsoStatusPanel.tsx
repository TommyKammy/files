'use client';

import {
  AlertTriangle,
  ClipboardCopy,
  Globe2,
  KeyRound,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { AdminSsoStatusResponse } from '@/types/files';

function ProviderLabel({ provider }: { provider: 'okta' | 'entra_id' }) {
  return <>{provider === 'entra_id' ? 'Microsoft Entra ID' : 'Okta'}</>;
}

interface SsoStatusPanelProps {
  status: AdminSsoStatusResponse | null;
  statusLoading: boolean;
  statusError: string | null;
  probeLoading: boolean;
  callbackCopied: boolean;
  localDevWarning: boolean;
  onProbeDiscovery: () => void;
  onCopyCallbackUrl: () => void;
}

/** Displays OIDC SSO environment status, callback URL, and configured IdP cards. */
export function SsoStatusPanel({
  status,
  statusLoading,
  statusError,
  probeLoading,
  callbackCopied,
  localDevWarning,
  onProbeDiscovery,
  onCopyCallbackUrl,
}: SsoStatusPanelProps) {
  return (
    <div
      data-testid="sso-status-section"
      className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-[#5e6ad2]" />
        <h3 className="text-sm font-semibold text-slate-900">
          OIDC SSO ステータス
        </h3>
        <button
          type="button"
          onClick={onProbeDiscovery}
          disabled={statusLoading || probeLoading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 py-1 text-[0.6875rem] font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3 w-3 ${probeLoading ? 'animate-spin' : ''}`}
          />
          Discovery を再確認
        </button>
      </div>

      {statusError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{statusError}</span>
        </div>
      )}

      {statusLoading && !status ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-600"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          IdP ステータスを読み込み中...
        </div>
      ) : status ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[0.625rem] text-slate-500">ENVIRONMENT</p>
              <p className="font-mono text-[0.75rem] font-semibold text-slate-900">
                {status.environment}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[0.625rem] text-slate-500">ALLOW_DEV_AUTH</p>
              <p
                className={`text-[0.75rem] font-semibold ${
                  status.allowDevAuth ? 'text-amber-700' : 'text-slate-900'
                }`}
              >
                {status.allowDevAuth ? '有効' : '無効'}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[0.625rem] text-slate-500">現在の接続元 IP</p>
              <p className="font-mono text-[0.75rem] font-semibold text-slate-900">
                {status.clientIp}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[0.625rem] text-slate-500">構成済み IdP</p>
              <p className="text-[0.75rem] font-semibold text-slate-900">
                {status.providers.length} プロバイダ
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[0.625rem] font-medium text-slate-500">
              Callback URL（IdP に登録するリダイレクト URI）
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-slate-50 px-2 py-1 font-mono text-[0.6875rem] text-slate-800">
                {status.callbackUrl}
              </code>
              <button
                type="button"
                data-testid="sso-callback-copy"
                onClick={onCopyCallbackUrl}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[0.6875rem] font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <ClipboardCopy className="h-3 w-3" />
                {callbackCopied ? 'コピー済み' : 'コピー'}
              </button>
            </div>
          </div>

          {status.providers.length === 0 ? (
            <p
              data-testid="sso-provider-empty"
              className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900"
            >
              構成済みの IdP がありません。OKTA_ISSUER / OKTA_CLIENT_ID または
              ENTRA_TENANT_ID / ENTRA_CLIENT_ID を設定してください。SSO
              必須を有効にする前に IdP の構成を完了してください。
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {status.providers.map((provider) => (
                <li
                  key={provider.provider}
                  data-testid="sso-provider-card"
                  className="rounded-xl border border-slate-200 bg-white p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                      <Globe2 className="h-3.5 w-3.5 text-[#5e6ad2]" />
                      <ProviderLabel provider={provider.provider} />
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                        provider.clientSecretConfigured
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-amber-50 text-amber-800'
                      }`}
                    >
                      {provider.clientSecretConfigured
                        ? 'Client Secret 設定済み'
                        : 'Client Secret 未設定'}
                    </span>
                  </div>
                  <dl className="mt-2 space-y-1 text-[0.6875rem]">
                    <div>
                      <dt className="text-slate-500">Issuer</dt>
                      <dd className="break-all font-mono text-slate-800">
                        {provider.issuer}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Client ID（マスク）</dt>
                      <dd className="font-mono text-slate-800">
                        {provider.clientIdMasked || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">JWKS URI</dt>
                      <dd className="break-all font-mono text-slate-800">
                        {provider.jwksUri ?? '未取得（Discovery で解決）'}
                      </dd>
                    </div>
                    {provider.discovery && (
                      <div>
                        <dt className="text-slate-500">Discovery</dt>
                        <dd
                          className={
                            provider.discovery.ok
                              ? 'text-emerald-700'
                              : 'text-red-700'
                          }
                        >
                          {provider.discovery.ok
                            ? '到達可能'
                            : `失敗: ${provider.discovery.error ?? '不明なエラー'}`}
                        </dd>
                      </div>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {localDevWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-amber-900">
          <p className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              ローカル開発/開発用認証が有効です。SSO 必須を有効にすると新規の{' '}
              <code className="font-mono">/auth/dev-login</code> と{' '}
              <code className="font-mono">X-Dev-User-Id</code>{' '}
              ヘッダバイパスは拒否されますが、既に発行済みの D1 セッション
              Cookie とゲスト認証は継続して利用できます。
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
