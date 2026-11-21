'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  LockKeyhole,
  Network,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  describeAuthControlError,
  IP_ALLOWLIST_MAX_ENTRIES,
  IP_ALLOWLIST_SCOPE_META,
  IP_ALLOWLIST_SCOPE_OPTIONS,
  parseIpAllowlistEntry,
  readIpAllowlist,
  readIpAllowlistEnabled,
  readIpAllowlistScope,
  validateIpAllowlistInput,
} from '@/lib/admin-ip-sso';
import { ApiClientError, updateAdminPolicies } from '@/lib/files-api';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type { AdminIpAllowlistScope, TenantPolicyRow } from '@/types/files';
import { NATIVE_SWITCH_ATTRS, sameStringList } from './shared';

interface IpAllowlistFormProps {
  canManage: boolean;
  policy: TenantPolicyRow | null;
  clientIp: string | undefined;
  onPolicyUpdated?: (policy: TenantPolicyRow) => void;
  onRefreshStatus: () => void;
}

/** Form for configuring tenant IP/CIDR allowlist and enforcement scope. */
export function IpAllowlistForm({
  canManage,
  policy,
  clientIp,
  onPolicyUpdated,
  onRefreshStatus,
}: IpAllowlistFormProps) {
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

  const persistedIpEnabled = readIpAllowlistEnabled(policy);
  const persistedIpScope = readIpAllowlistScope(policy);
  const persistedIpEntries = readIpAllowlist(policy);

  const ipDirty =
    ipEnabled !== persistedIpEnabled ||
    ipScope !== persistedIpScope ||
    !sameStringList(ipEntries, persistedIpEntries);

  const ipDirtyRef = useRef(false);
  ipDirtyRef.current = ipDirty;

  useEffect(() => {
    if (ipDirtyRef.current) return;
    setIpEnabled(readIpAllowlistEnabled(policy));
    setIpScope(readIpAllowlistScope(policy));
    setIpEntries(readIpAllowlist(policy));
  }, [policy]);

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
      onRefreshStatus();
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

  return (
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
                disabled={!canManage || !clientIp}
                onClick={() => {
                  if (clientIp) addIpEntry(clientIp);
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
              {clientIp ?? '取得中...'}
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
  );
}
