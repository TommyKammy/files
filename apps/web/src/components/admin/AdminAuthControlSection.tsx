'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Globe2,
  Info,
  KeyRound,
  Loader2,
  LockKeyhole,
  Network,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  canManageAuthControls,
  describeAuthControlError,
  IP_ALLOWLIST_MAX_ENTRIES,
  IP_ALLOWLIST_SCOPE_META,
  IP_ALLOWLIST_SCOPE_OPTIONS,
  parseIpAllowlistEntry,
  readIpAllowlist,
  readIpAllowlistEnabled,
  readIpAllowlistScope,
  readRequireSsoLogin,
  readSsoAllowedDomains,
  validateIpAllowlistInput,
  validateSsoAllowedDomains,
} from '@/lib/admin-ip-sso';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import {
  ApiClientError,
  fetchAdminSsoStatus,
  updateAdminPolicies,
} from '@/lib/files-api';
import type {
  AdminIpAllowlistScope,
  AdminSsoStatusResponse,
  AuthUser,
  TenantPolicyRow,
} from '@/types/files';

const NATIVE_SWITCH_ATTRS = {
  switch: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

function sameStringList(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function ProviderLabel({ provider }: { provider: 'okta' | 'entra_id' }) {
  return <>{provider === 'entra_id' ? 'Microsoft Entra ID' : 'Okta'}</>;
}

export function AdminAuthControlSection({
  user,
  policy,
  onPolicyUpdated,
}: {
  user: AuthUser;
  policy: TenantPolicyRow | null;
  onPolicyUpdated?: (policy: TenantPolicyRow) => void;
}) {
  const canManage = canManageAuthControls(user.role);

  const [status, setStatus] = useState<AdminSsoStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [callbackCopied, setCallbackCopied] = useState(false);

  const [ipEnabled, setIpEnabled] = useState(() =>
    readIpAllowlistEnabled(policy)
  );
  const [ipScope, setIpScope] = useState<AdminIpAllowlistScope>(() =>
    readIpAllowlistScope(policy)
  );
  const [ipEntries, setIpEntries] = useState<string[]>(() =>
    readIpAllowlist(policy)
  );
  const [ipInput, setIpInput] = useState('');
  const [ipSaving, setIpSaving] = useState(false);
  const [ipError, setIpError] = useState<string | null>(null);
  const [ipNotice, setIpNotice] = useState<string | null>(null);

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

  const persistedIpEnabled = readIpAllowlistEnabled(policy);
  const persistedIpScope = readIpAllowlistScope(policy);
  const persistedIpEntries = readIpAllowlist(policy);
  const persistedRequireSso = readRequireSsoLogin(policy);
  const persistedSsoDomains = readSsoAllowedDomains(policy);

  const ipDirty =
    ipEnabled !== persistedIpEnabled ||
    ipScope !== persistedIpScope ||
    !sameStringList(ipEntries, persistedIpEntries);
  const ssoDirty =
    requireSso !== persistedRequireSso ||
    !sameStringList(ssoDomains, persistedSsoDomains);

  const ipDirtyRef = useRef(false);
  const ssoDirtyRef = useRef(false);
  ipDirtyRef.current = ipDirty;
  ssoDirtyRef.current = ssoDirty;

  useEffect(() => {
    let active = true;
    setStatusLoading(true);
    fetchAdminSsoStatus()
      .then((response) => {
        if (!active) return;
        setStatus(response);
        setStatusError(null);
      })
      .catch((err) => {
        if (!active) return;
        setStatusError(
          err instanceof ApiClientError
            ? err.message
            : 'SSO ステータスの取得に失敗しました'
        );
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (ipDirtyRef.current) return;
    setIpEnabled(readIpAllowlistEnabled(policy));
    setIpScope(readIpAllowlistScope(policy));
    setIpEntries(readIpAllowlist(policy));
  }, [policy]);

  useEffect(() => {
    if (ssoDirtyRef.current) return;
    setRequireSso(readRequireSsoLogin(policy));
    setSsoDomains(readSsoAllowedDomains(policy));
  }, [policy]);

  async function refreshStatus(probeDiscovery: boolean) {
    if (probeDiscovery) setProbeLoading(true);
    else setStatusLoading(true);
    try {
      const response = await fetchAdminSsoStatus({ probeDiscovery });
      setStatus(response);
      setStatusError(null);
    } catch (err) {
      setStatusError(
        err instanceof ApiClientError
          ? err.message
          : 'SSO ステータスの取得に失敗しました'
      );
    } finally {
      if (probeDiscovery) setProbeLoading(false);
      else setStatusLoading(false);
    }
  }

  function addIpEntry(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const validation = validateIpAllowlistInput([trimmed]);
    if (!validation.ok) {
      setIpError(
        `IP アドレス / CIDR の形式が不正です: ${trimmed}（IPv4 例: 203.0.113.10 または 203.0.113.0/24 / IPv6 例: 2001:db8::1 または 2001:db8::/32）`
      );
      return false;
    }
    const normalized = validation.entries[0]!;
    const alreadyAdded = ipEntries.some(
      (entry) => parseIpAllowlistEntry(entry)?.normalized === normalized
    );
    if (alreadyAdded) {
      setIpError(`${normalized} は既に許可リストに追加されています。`);
      return false;
    }
    if (ipEntries.length >= IP_ALLOWLIST_MAX_ENTRIES) {
      setIpError(`許可リストは最大 ${IP_ALLOWLIST_MAX_ENTRIES} 件です。`);
      return false;
    }
    setIpEntries((previous) => [...previous, normalized]);
    setIpInput('');
    setIpError(null);
    setIpNotice(null);
    return true;
  }

  function removeIpEntry(entry: string) {
    setIpEntries((previous) => previous.filter((value) => value !== entry));
    setIpError(null);
    setIpNotice(null);
  }

  async function handleIpSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || ipSaving || !policy) return;

    const validation = validateIpAllowlistInput(ipEntries);
    if (!validation.ok) {
      setIpError(
        validation.invalidEntries.length > 0
          ? `IP アドレス / CIDR の形式が不正です: ${validation.invalidEntries.join(', ')}`
          : `許可リストは最大 ${IP_ALLOWLIST_MAX_ENTRIES} 件です。`
      );
      return;
    }

    setIpSaving(true);
    setIpError(null);
    setIpNotice(null);
    try {
      const response = await updateAdminPolicies({
        ipAllowlistEnabled: ipEnabled,
        ipAllowlistScope: ipScope,
        ipAllowlist: validation.entries,
      });
      onPolicyUpdated?.(response.policy);
      setIpEntries(validation.entries);
      setIpNotice(
        ipEnabled
          ? `IP 許可リストを保存しました。適用スコープ: ${IP_ALLOWLIST_SCOPE_META[ipScope].label}`
          : 'IP 許可リストを無効化しました。'
      );
      void refreshStatus(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setIpError(
          describeAuthControlError(err.code, err.message, err.details)
        );
      } else {
        setIpError('IP 許可リストの更新に失敗しました');
      }
    } finally {
      setIpSaving(false);
    }
  }

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
      void refreshStatus(false);
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

  async function copyCallbackUrl() {
    if (!status?.callbackUrl) return;
    try {
      await navigator.clipboard.writeText(status.callbackUrl);
      setCallbackCopied(true);
      window.setTimeout(() => setCallbackCopied(false), 2000);
    } catch {
      setCallbackCopied(false);
    }
  }

  const localDevWarning =
    status?.environment === 'local' || status?.allowDevAuth === true;

  return (
    <section
      id="admin-auth-control-section"
      data-testid="admin-auth-control-section"
      aria-labelledby="auth-control-heading"
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" />
        <h2
          id="auth-control-heading"
          className="text-sm font-semibold text-slate-900"
        >
          IP 許可リスト & OIDC SSO 認証統制
        </h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
          {canManage ? 'sys_admin 編集可能' : 'sec_admin 閲覧のみ'}
        </span>
      </div>

      {!canManage && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
          IP 許可リストと OIDC SSO
          ポリシーを変更できるのはシステム管理者（sys_admin）だけです。セキュリティ管理者（sec_admin）は現在の設定と IdP
          ステータスを読み取り専用で確認できます。
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* IP allowlist                                                      */}
      {/* ---------------------------------------------------------------- */}
      <form
        onSubmit={handleIpSave}
        aria-labelledby="ip-allowlist-heading"
        data-testid="ip-allowlist-section"
        className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Network className="h-4 w-4 text-[#5e6ad2]" />
          <h3
            id="ip-allowlist-heading"
            className="text-sm font-semibold text-slate-900"
          >
            IP アドレス許可リスト
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
              persistedIpEnabled
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-slate-100 text-slate-700'
            }`}
          >
            現在: {persistedIpEnabled ? '有効' : '無効'}
          </span>
        </div>
        <p className="text-[0.6875rem] leading-relaxed text-slate-600">
          IPv4 / IPv6 の単一 IP または CIDR
          を登録し、テナント境界のアクセス元を制限します。保存時に現在の接続元 IP
          がリスト外だと自己ロックアウトを防ぐため拒否されます。
        </p>

        <fieldset disabled={!policy || ipSaving} className="space-y-4">
          <legend className="sr-only">IP 許可リスト設定</legend>

          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-start sm:justify-between">
            <label
              htmlFor="ip-allowlist-enabled"
              className="flex cursor-pointer items-start gap-3 text-xs"
            >
              <input
                {...NATIVE_SWITCH_ATTRS}
                id="ip-allowlist-enabled"
                data-testid="ip-allowlist-enabled"
                name="ipAllowlistEnabled"
                type="checkbox"
                checked={ipEnabled}
                disabled={!canManage}
                onChange={(event) => {
                  setIpEnabled(event.target.checked);
                  setIpError(null);
                  setIpNotice(null);
                }}
                className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
              />
              <span className="min-w-0">
                <span className="block font-semibold text-slate-900">
                  IP 許可リストを有効化
                </span>
                <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600">
                  無効時はすべての IP からのアクセスを許可します（従来の動作）。
                  有効化すると選択したスコープで照合を強制します。
                </span>
              </span>
            </label>

            <div className="w-full shrink-0 sm:w-64">
              <label
                htmlFor="ip-allowlist-scope"
                className="block text-[0.6875rem] font-semibold text-slate-700"
              >
                適用スコープ
              </label>
              <select
                id="ip-allowlist-scope"
                data-testid="ip-allowlist-scope"
                value={ipScope}
                disabled={!canManage}
                onChange={(event) => {
                  setIpScope(event.target.value as AdminIpAllowlistScope);
                  setIpError(null);
                  setIpNotice(null);
                }}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[0.75rem] text-slate-900 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {IP_ALLOWLIST_SCOPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {IP_ALLOWLIST_SCOPE_META[option].label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[0.625rem] leading-relaxed text-slate-500">
                {IP_ALLOWLIST_SCOPE_META[ipScope].description}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="ip-allowlist-input"
              className="block text-xs font-semibold text-slate-700"
            >
              許可する IP / CIDR
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="ip-allowlist-input"
                data-testid="ip-allowlist-input"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={ipInput}
                disabled={!canManage}
                placeholder="203.0.113.10 / 203.0.113.0/24 / 2001:db8::/32"
                onChange={(event) => {
                  setIpInput(event.target.value);
                  setIpError(null);
                }}
                onKeyDown={(event) => {
                  if (isImeComposingEvent(event.nativeEvent)) return;
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  addIpEntry(ipInput);
                }}
                className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-[0.75rem] text-slate-900 placeholder:text-slate-400 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="ip-allowlist-add"
                  disabled={!canManage || !ipInput.trim()}
                  onClick={() => addIpEntry(ipInput)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[0.75rem] font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  追加
                </button>
                <button
                  type="button"
                  data-testid="ip-allowlist-add-current"
                  disabled={!canManage || !status?.clientIp}
                  onClick={() => {
                    if (status?.clientIp) addIpEntry(status.clientIp);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-2.5 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LockKeyhole className="h-3.5 w-3.5" />
                  現在の接続元 IP を追加
                </button>
              </div>
            </div>
            <p className="text-[0.625rem] text-slate-500">
              現在の接続元 IP:{' '}
              <span
                data-testid="ip-allowlist-current-ip"
                className="font-mono text-slate-700"
              >
                {status?.clientIp ?? '取得中...'}
              </span>
              （{ipEntries.length} / {IP_ALLOWLIST_MAX_ENTRIES} 件）
            </p>
          </div>

          {ipEntries.length === 0 ? (
            <p
              data-testid="ip-allowlist-empty"
              className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-600"
            >
              許可リストは空です。有効化する場合は、最低 1
              件（通常は現在の接続元 IP）を追加してください。
            </p>
          ) : (
            <ul
              aria-label="IP 許可リスト"
              className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200"
            >
              {ipEntries.map((entry) => (
                <li
                  key={entry}
                  data-testid="ip-allowlist-entry"
                  className="flex items-center justify-between gap-3 bg-white px-3 py-2"
                >
                  <span className="font-mono text-[0.75rem] text-slate-800">
                    {entry}
                  </span>
                  <button
                    type="button"
                    disabled={!canManage}
                    onClick={() => removeIpEntry(entry)}
                    aria-label={`${entry} を許可リストから削除`}
                    className="rounded-md border border-slate-300 px-2 py-0.5 text-[0.6875rem] font-medium text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div aria-live="assertive" aria-atomic="true" className="min-h-0">
            {ipError && (
              <div
                role="alert"
                data-testid="ip-allowlist-error"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{ipError}</span>
              </div>
            )}
            {!ipError && ipNotice && (
              <div
                role="status"
                data-testid="ip-allowlist-notice"
                className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{ipNotice}</span>
              </div>
            )}
            {!ipError && !ipNotice && ipDirty && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>未保存の IP 許可リスト変更があります。</span>
              </div>
            )}
          </div>

          {canManage && (
            <div className="flex items-center justify-end">
              <button
                type="submit"
                data-testid="ip-allowlist-save"
                disabled={!policy || ipSaving || !ipDirty}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ipSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>{ipSaving ? '保存中...' : 'IP 許可リストを保存'}</span>
              </button>
            </div>
          )}
        </fieldset>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* OIDC SSO status & policy                                         */}
      {/* ---------------------------------------------------------------- */}
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
            onClick={() => void refreshStatus(true)}
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
                <p className="text-[0.625rem] text-slate-500">
                  構成済み IdP
                </p>
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
                  onClick={() => void copyCallbackUrl()}
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
                構成済みの IdP
                がありません。OKTA_ISSUER / OKTA_CLIENT_ID または ENTRA_TENANT_ID / ENTRA_CLIENT_ID
                を設定してください。SSO 必須を有効にする前に IdP の構成を完了してください。
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
                ローカル開発/開発用認証が有効です。SSO
                必須を有効にすると新規の <code className="font-mono">/auth/dev-login</code>{' '}
                と <code className="font-mono">X-Dev-User-Id</code>{' '}
                ヘッダバイパスは拒否されますが、既に発行済みの D1
                セッション Cookie とゲスト認証は継続して利用できます。
              </span>
            </p>
          </div>
        )}
      </div>

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
                  新規のパスワードレス開発ログインとヘッダ認証バイパスを拒否します。既存の正規 D1
                  セッション Cookie とゲスト招待/OTP 認証は維持されます。
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
              空の場合は IdP が検証したすべてのメールドメインを許可します。ワイルドカード
              (*) は使用できません。
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
    </section>
  );
}
