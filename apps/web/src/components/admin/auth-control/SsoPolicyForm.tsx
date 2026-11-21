'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  KeyRound,
  Loader2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  describeAuthControlError,
  readRequireSsoLogin,
  readSsoAllowedDomains,
  validateSsoAllowedDomains,
} from '@/lib/admin-ip-sso';
import { ApiClientError, updateAdminPolicies } from '@/lib/files-api';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type { TenantPolicyRow } from '@/types/files';
import { NATIVE_SWITCH_ATTRS, sameStringList } from './shared';

interface SsoPolicyFormProps {
  canManage: boolean;
  policy: TenantPolicyRow | null;
  onPolicyUpdated?: (policy: TenantPolicyRow) => void;
  onRefreshStatus: () => void;
}

/** Form for configuring OIDC SSO enforcement and exact-match allowed domains. */
export function SsoPolicyForm({
  canManage,
  policy,
  onPolicyUpdated,
  onRefreshStatus,
}: SsoPolicyFormProps) {
  const [requireSso, setRequireSso] = useState<boolean>(() =>
    readRequireSsoLogin(policy)
  );
  const [ssoDomains, setSsoDomains] = useState<string[]>(() =>
    readSsoAllowedDomains(policy)
  );
  const [ssoDomainInput, setSsoDomainInput] = useState('');
  const [ssoSaving, setSsoSaving] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoNotice, setSsoNotice] = useState<string | null>(null);

  const persistedRequireSso = readRequireSsoLogin(policy);
  const persistedSsoDomains = readSsoAllowedDomains(policy);

  const ssoDirty =
    requireSso !== persistedRequireSso ||
    !sameStringList(ssoDomains, persistedSsoDomains);

  const ssoDirtyRef = useRef(false);
  ssoDirtyRef.current = ssoDirty;

  useEffect(() => {
    if (ssoDirtyRef.current) return;
    setRequireSso(readRequireSsoLogin(policy));
    setSsoDomains(readSsoAllowedDomains(policy));
  }, [policy]);

  function addSsoDomain(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const validation = validateSsoAllowedDomains([trimmed]);
    if (!validation.ok) {
      setSsoError(
        validation.wildcardDomains.length > 0
          ? 'ワイルドカード (*) は使用できません。完全一致のドメインのみ許可されます。'
          : `SSO 許可ドメインの形式が不正です: ${trimmed}（例: example.com）`
      );
      return false;
    }
    const normalized = validation.domains[0]!;
    if (ssoDomains.includes(normalized)) {
      setSsoError(`${normalized} は既に許可ドメインに追加されています。`);
      return false;
    }
    setSsoDomains((previous) => [...previous, normalized]);
    setSsoDomainInput('');
    setSsoError(null);
    setSsoNotice(null);
    return true;
  }

  function removeSsoDomain(domain: string) {
    setSsoDomains((previous) => previous.filter((value) => value !== domain));
    setSsoError(null);
    setSsoNotice(null);
  }

  async function handleSsoSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || ssoSaving || !policy) return;

    const validation = validateSsoAllowedDomains(ssoDomains);
    if (!validation.ok) {
      setSsoError(
        validation.wildcardDomains.length > 0
          ? 'ワイルドカード (*) は使用できません。完全一致のドメインのみ許可されます。'
          : `SSO 許可ドメインの形式が不正です: ${validation.invalidDomains.join(', ')}`
      );
      return;
    }

    setSsoSaving(true);
    setSsoError(null);
    setSsoNotice(null);
    try {
      const response = await updateAdminPolicies({
        requireSsoLogin: requireSso,
        ssoAllowedDomains: validation.domains,
      });
      onPolicyUpdated?.(response.policy);
      setSsoDomains(validation.domains);
      setSsoNotice(
        requireSso
          ? 'OIDC SSO ログインを必須にしました。ローカル開発用の /auth/dev-login とヘッダバイパスは拒否されます。'
          : 'OIDC SSO ログインの必須設定を解除しました。'
      );
      onRefreshStatus();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setSsoError(
          describeAuthControlError(err.code, err.message, err.details)
        );
      } else {
        setSsoError('SSO ポリシーの更新に失敗しました');
      }
    } finally {
      setSsoSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSsoSave}
      aria-labelledby="sso-policy-heading"
      data-testid="sso-policy-section"
      className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-[#5e6ad2]" />
        <h3
          id="sso-policy-heading"
          className="text-sm font-semibold text-slate-900"
        >
          OIDC SSO ログインポリシー
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
            persistedRequireSso
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-slate-100 text-slate-700'
          }`}
        >
          現在: {persistedRequireSso ? 'SSO 必須' : '任意'}
        </span>
      </div>

      <fieldset disabled={!policy || ssoSaving} className="space-y-4">
        <legend className="sr-only">OIDC SSO ログインポリシー設定</legend>

        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-start sm:justify-between">
          <label
            htmlFor="require-sso-login"
            className="flex cursor-pointer items-start gap-3 text-xs"
          >
            <input
              {...NATIVE_SWITCH_ATTRS}
              id="require-sso-login"
              data-testid="require-sso-login"
              name="requireSsoLogin"
              type="checkbox"
              checked={requireSso}
              disabled={!canManage}
              onChange={(event) => {
                setRequireSso(event.target.checked);
                setSsoError(null);
                setSsoNotice(null);
              }}
              className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="min-w-0">
              <span className="block font-semibold text-slate-900">
                SSO ログインを必須にする
              </span>
              <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600">
                新規のパスワードレス開発ログインとヘッダ認証バイパスを拒否します。既存の正規
                D1 セッション Cookie とゲスト招待/OTP 認証は維持されます。
              </span>
            </span>
          </label>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="sso-domain-input"
            className="block text-xs font-semibold text-slate-700"
          >
            SSO 許可ドメイン（完全一致）
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="sso-domain-input"
              data-testid="sso-domain-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={ssoDomainInput}
              disabled={!canManage}
              placeholder="example.com"
              onChange={(event) => {
                setSsoDomainInput(event.target.value);
                setSsoError(null);
              }}
              onKeyDown={(event) => {
                if (isImeComposingEvent(event.nativeEvent)) return;
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addSsoDomain(ssoDomainInput);
              }}
              className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-[0.75rem] text-slate-900 placeholder:text-slate-400 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              data-testid="sso-domain-add"
              disabled={!canManage || !ssoDomainInput.trim()}
              onClick={() => addSsoDomain(ssoDomainInput)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[0.75rem] font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              追加
            </button>
          </div>
          <p className="text-[0.625rem] leading-relaxed text-slate-500">
            空の場合は IdP
            が検証したすべてのメールドメインを許可します。ワイルドカード (*)
            は使用できません。
          </p>
        </div>

        {ssoDomains.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-600">
            許可ドメインは未設定です（全 IdP 検証済みドメインを許可）。
          </p>
        ) : (
          <ul
            aria-label="SSO 許可ドメイン"
            className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200"
          >
            {ssoDomains.map((domain) => (
              <li
                key={domain}
                data-testid="sso-domain-entry"
                className="flex items-center justify-between gap-3 bg-white px-3 py-2"
              >
                <span className="font-mono text-[0.75rem] text-slate-800">
                  @{domain}
                </span>
                <button
                  type="button"
                  disabled={!canManage}
                  onClick={() => removeSsoDomain(domain)}
                  aria-label={`${domain} を許可ドメインから削除`}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-[0.6875rem] font-medium text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}

        <div aria-live="assertive" aria-atomic="true" className="min-h-0">
          {ssoError && (
            <div
              role="alert"
              data-testid="sso-policy-error"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{ssoError}</span>
            </div>
          )}
          {!ssoError && ssoNotice && (
            <div
              role="status"
              data-testid="sso-policy-notice"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{ssoNotice}</span>
            </div>
          )}
          {!ssoError && !ssoNotice && ssoDirty && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
            >
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>未保存の SSO ポリシー変更があります。</span>
            </div>
          )}
        </div>

        {canManage && (
          <div className="flex items-center justify-end">
            <button
              type="submit"
              data-testid="sso-policy-save"
              disabled={!policy || ssoSaving || !ssoDirty}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ssoSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{ssoSaving ? '保存中...' : 'SSO ポリシーを保存'}</span>
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
