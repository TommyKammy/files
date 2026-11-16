'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe2,
  Loader2,
  Mail,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  fetchGuestInvitations,
  resendGuestInvitation,
  revokeGuestInvitation,
  updateAdminPolicies,
} from '@/lib/files-api';
import {
  guestInvitationStatusLabel,
  normalizeDomainAllowlist,
} from '@/lib/guest-policy';
import type {
  GuestInvitationSummary,
  TenantPolicyRow,
} from '@/types/files';

const NATIVE_SWITCH_ATTRS = {
  switch: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

interface GuestPolicySectionProps {
  policy: TenantPolicyRow | null;
  canManage: boolean;
  onPolicyUpdated: (policy: TenantPolicyRow | null) => void;
}

function readBooleanPolicy(
  policy: TenantPolicyRow | null,
  camel: keyof TenantPolicyRow,
  snake: keyof TenantPolicyRow
): boolean {
  if (!policy) return false;
  const camelValue = policy[camel];
  if (typeof camelValue === 'boolean') return camelValue;
  return policy[snake] === 1;
}

function readNumberPolicy(
  policy: TenantPolicyRow | null,
  camel: keyof TenantPolicyRow,
  snake: keyof TenantPolicyRow,
  fallback: number
): number {
  const raw = policy?.[camel] ?? policy?.[snake];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

export function GuestPolicySection({
  policy,
  canManage,
  onPolicyUpdated,
}: GuestPolicySectionProps) {
  const persistedAllow = readBooleanPolicy(
    policy,
    'allowExternalCollaborators',
    'allow_external_collaborators'
  );
  const persistedElevated = readBooleanPolicy(
    policy,
    'allowGuestElevatedRoles',
    'allow_guest_elevated_roles'
  );
  const persistedDomains = normalizeDomainAllowlist(
    policy?.externalDomainAllowlist ??
      (() => {
        try {
          return JSON.parse(policy?.external_domain_allowlist_json ?? '[]');
        } catch {
          return [];
        }
      })()
  );
  const persistedExpiry = readNumberPolicy(
    policy,
    'guestInvitationExpiryDays',
    'guest_invitation_expiry_days',
    14
  );
  const persistedSession = readNumberPolicy(
    policy,
    'guestSessionMaxHours',
    'guest_session_max_hours',
    24
  );

  const [allowExternalCollaborators, setAllowExternalCollaborators] = useState(
    persistedAllow
  );
  const [allowGuestElevatedRoles, setAllowGuestElevatedRoles] = useState(
    persistedElevated
  );
  const [domains, setDomains] = useState<string[]>(persistedDomains);
  const [domainDraft, setDomainDraft] = useState('');
  const [expiryDays, setExpiryDays] = useState(String(persistedExpiry));
  const [sessionHours, setSessionHours] = useState(String(persistedSession));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [invitations, setInvitations] = useState<GuestInvitationSummary[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationNotice, setInvitationNotice] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!policy) return;
    setAllowExternalCollaborators(
      readBooleanPolicy(
        policy,
        'allowExternalCollaborators',
        'allow_external_collaborators'
      )
    );
    setAllowGuestElevatedRoles(
      readBooleanPolicy(
        policy,
        'allowGuestElevatedRoles',
        'allow_guest_elevated_roles'
      )
    );
    let rawDomains: unknown = policy.externalDomainAllowlist;
    if (!Array.isArray(rawDomains)) {
      try {
        rawDomains = JSON.parse(policy.external_domain_allowlist_json ?? '[]');
      } catch {
        rawDomains = [];
      }
    }
    setDomains(normalizeDomainAllowlist(rawDomains));
    setExpiryDays(
      String(
        readNumberPolicy(
          policy,
          'guestInvitationExpiryDays',
          'guest_invitation_expiry_days',
          14
        )
      )
    );
    setSessionHours(
      String(
        readNumberPolicy(
          policy,
          'guestSessionMaxHours',
          'guest_session_max_hours',
          24
        )
      )
    );
  }, [policy]);

  const loadInvitations = useCallback(async () => {
    if (!canManage) return;
    setInvitationsLoading(true);
    try {
      const response = await fetchGuestInvitations();
      setInvitations(response.invitations);
      setInvitationError(null);
    } catch (err) {
      setInvitationError(
        err instanceof ApiClientError
          ? err.message
          : 'ゲスト招待一覧の読み込みに失敗しました'
      );
    } finally {
      setInvitationsLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      void loadInvitations();
    }
  }, [loadInvitations]);

  function addDomain() {
    const normalized = normalizeDomainAllowlist([domainDraft])[0] ?? null;
    setDomainDraft('');
    if (!normalized) {
      setError('有効なドメインを入力してください（例: partner.example.com）');
      return;
    }
    setError(null);
    setDomains((prev) =>
      prev.includes(normalized) ? prev : [...prev, normalized].sort()
    );
  }

  function removeDomain(domain: string) {
    setDomains((prev) => prev.filter((item) => item !== domain));
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || saving) return;

    const expiry = Number(expiryDays);
    const session = Number(sessionHours);
    if (!Number.isInteger(expiry) || expiry < 1 || expiry > 365) {
      setError('招待有効期限は 1〜365 日の整数で指定してください。');
      return;
    }
    if (!Number.isInteger(session) || session < 1 || session > 168) {
      setError('ゲストセッション上限は 1〜168 時間の整数で指定してください。');
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await updateAdminPolicies({
        allowExternalCollaborators,
        allowGuestElevatedRoles,
        externalDomainAllowlist: domains,
        guestInvitationExpiryDays: expiry,
        guestSessionMaxHours: session,
      });
      onPolicyUpdated(response.policy);
      setNotice('外部ゲストポリシーを保存しました。');
      void loadInvitations();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '外部ゲストポリシーの保存に失敗しました'
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleResend(invitationId: string) {
    if (busyInvitationId) return;
    setBusyInvitationId(invitationId);
    setInvitationError(null);
    setInvitationNotice(null);
    try {
      await resendGuestInvitation(invitationId);
      setInvitationNotice('招待メールを再送しました。以前の招待 URL は無効になりました。');
      await loadInvitations();
    } catch (err) {
      setInvitationError(
        err instanceof ApiClientError ? err.message : '招待の再送に失敗しました'
      );
    } finally {
      setBusyInvitationId(null);
    }
  }

  async function handleRevoke(invitationId: string) {
    if (busyInvitationId) return;
    setBusyInvitationId(invitationId);
    setInvitationError(null);
    setInvitationNotice(null);
    try {
      await revokeGuestInvitation(invitationId);
      setInvitationNotice('招待を取り消し、ゲストの有効セッションを失効させました。');
      await loadInvitations();
    } catch (err) {
      setInvitationError(
        err instanceof ApiClientError ? err.message : '招待の取消に失敗しました'
      );
    } finally {
      setBusyInvitationId(null);
    }
  }

  return (
    <section
      data-testid="guest-policy-section"
      aria-labelledby="guest-policy-heading"
      className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Users className="mt-0.5 h-4 w-4 text-[#5e6ad2]" />
          <div>
            <h2
              id="guest-policy-heading"
              className="text-[0.875rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              外部ゲストコラボレーター
            </h2>
            <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
              社外ユーザーをメール招待 + ワンタイムコードで限定フォルダに接続します。
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-[#e1e1e4] bg-[#f9f9fa] px-2 py-0.5 text-[0.625rem] font-medium text-[#55565a]">
          <ShieldCheck className="h-3 w-3" />
          {canManage ? 'sys_admin が変更できます' : 'sec_admin は閲覧のみ'}
        </span>
      </header>

      <div
        data-testid="guest-policy-comparison-guide"
        className="mb-4 grid gap-3 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3 text-[0.6875rem] text-[#3c3f46] md:grid-cols-2"
      >
        <div>
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-[#111214]">
            <ExternalLink className="h-3.5 w-3.5 text-[#5e6ad2]" />
            共有リンク
          </p>
          <ul className="list-inside list-disc space-y-0.5">
            <li>URL を知っている相手にファイル/フォルダを一時公開</li>
            <li>社外にワークスペース権限は付与しない</li>
            <li>パスワード・期限・ダウンロード可否で統制</li>
            <li>提出用途はファイルリクエストを使用</li>
          </ul>
        </div>
        <div>
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-[#111214]">
            <UserPlus className="h-3.5 w-3.5 text-[#5e6ad2]" />
            外部ゲストコラボレーター
          </p>
          <ul className="list-inside list-disc space-y-0.5">
            <li>メール招待 + 6 桁 OTP で本人確認</li>
            <li>指定フォルダにだけロールを付与</li>
            <li>アカウント/セッションに有効期限を強制</li>
            <li>管理画面・ルート作成・監査ログにはアクセス不可</li>
          </ul>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-4" noValidate>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-start justify-between gap-3 rounded-xl border border-[#e7e7ea] p-3">
            <span>
              <span className="block text-[0.75rem] font-medium text-[#111214]">
                外部コラボレーターを許可
              </span>
              <span className="mt-0.5 block text-[0.625rem] text-[#55565a]">
                無効時は招待・承諾・OTP ログインをすべて拒否します。
              </span>
            </span>
            <input
              {...NATIVE_SWITCH_ATTRS}
              type="checkbox"
              role="switch"
              aria-checked={allowExternalCollaborators}
              aria-label="外部コラボレーターを許可"
              data-testid="guest-allow-external-collaborators"
              checked={allowExternalCollaborators}
              disabled={!canManage || saving}
              onChange={(event) => setAllowExternalCollaborators(event.target.checked)}
              className="mt-1 h-5 w-9 shrink-0 cursor-pointer accent-[#5e6ad2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <label className="flex items-start justify-between gap-3 rounded-xl border border-[#e7e7ea] p-3">
            <span>
              <span className="block text-[0.75rem] font-medium text-[#111214]">
                ゲストに editor ロールを許可
              </span>
              <span className="mt-0.5 block text-[0.625rem] text-[#55565a]">
                owner / co_owner は常に付与不可。高度ロールは別途「高度ロール」設定とフォルダ限定が必要です。
              </span>
            </span>
            <input
              {...NATIVE_SWITCH_ATTRS}
              type="checkbox"
              role="switch"
              aria-checked={allowGuestElevatedRoles}
              aria-label="ゲストに editor ロールを許可"
              data-testid="guest-allow-elevated-roles"
              checked={allowGuestElevatedRoles}
              disabled={!canManage || saving}
              onChange={(event) => setAllowGuestElevatedRoles(event.target.checked)}
              className="mt-1 h-5 w-9 shrink-0 cursor-pointer accent-[#5e6ad2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        </div>

        <fieldset className="rounded-xl border border-[#e7e7ea] p-3">
          <legend className="flex items-center gap-1.5 px-1 text-[0.75rem] font-medium text-[#111214]">
            <Globe2 className="h-3.5 w-3.5 text-[#5e6ad2]" />
            外部ドメイン許可リスト
          </legend>
          <p className="mb-2 text-[0.625rem] text-[#55565a]">
            空の場合はすべての外部ドメインを拒否します。明示的に追加したドメインだけ招待できます。
          </p>
          <div className="flex flex-wrap gap-2">
            <label htmlFor="guest-domain-input" className="sr-only">
              追加する外部ドメイン
            </label>
            <input
              id="guest-domain-input"
              data-testid="guest-domain-input"
              name="guestDomain"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="partner.example.com"
              value={domainDraft}
              disabled={!canManage || saving}
              onChange={(event) => setDomainDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addDomain();
                }
              }}
              className="field-input h-8 min-w-[16rem] flex-1 rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem] text-[#111214] placeholder:text-[#8a8b90]"
            />
            <button
              type="button"
              data-testid="guest-domain-add"
              onClick={addDomain}
              disabled={!canManage || saving || !domainDraft.trim()}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
            >
              ゲストドメインを追加
            </button>
          </div>
          {domains.length === 0 ? (
            <p
              data-testid="guest-domain-empty"
              className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[0.625rem] text-amber-800"
            >
              許可ドメイン未設定のため、外部ゲストの招待は作成できません。
            </p>
          ) : (
            <ul
              data-testid="guest-domain-list"
              className="mt-2 flex flex-wrap gap-1.5"
            >
              {domains.map((domain) => (
                <li
                  key={domain}
                  className="inline-flex items-center gap-1 rounded-full border border-[#d7d7dc] bg-[#f9f9fa] py-0.5 pl-2 pr-1 text-[0.6875rem] text-[#3c3f46]"
                >
                  <span>{domain}</span>
                  <button
                    type="button"
                    aria-label={`${domain} を許可リストから削除`}
                    onClick={() => removeDomain(domain)}
                    disabled={!canManage || saving}
                    className="rounded-full p-0.5 text-[#676b72] transition hover:bg-[#e6e6e8] hover:text-[#111214] disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label
              htmlFor="guest-invitation-expiry-days"
              className="mb-1 block text-[0.75rem] font-medium text-[#111214]"
            >
              招待の有効期限（日）
            </label>
            <input
              id="guest-invitation-expiry-days"
              data-testid="guest-invitation-expiry-days"
              name="guestInvitationExpiryDays"
              type="number"
              min={1}
              max={365}
              step={1}
              required
              value={expiryDays}
              disabled={!canManage || saving}
              onChange={(event) => setExpiryDays(event.target.value)}
              className="field-input h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem] text-[#111214]"
            />
          </div>
          <div>
            <label
              htmlFor="guest-session-max-hours"
              className="mb-1 block text-[0.75rem] font-medium text-[#111214]"
            >
              ゲストセッション上限（時間）
            </label>
            <input
              id="guest-session-max-hours"
              data-testid="guest-session-max-hours"
              name="guestSessionMaxHours"
              type="number"
              min={1}
              max={168}
              step={1}
              required
              value={sessionHours}
              disabled={!canManage || saving}
              onChange={(event) => setSessionHours(event.target.value)}
              className="field-input h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem] text-[#111214]"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[0.625rem] text-[#55565a]">
            保存内容は招待の承諾・OTP ログイン時に毎回再検証されます。
          </p>
          <button
            type="submit"
            data-testid="guest-policy-save"
            disabled={!canManage || saving}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            ゲストポリシーを保存
          </button>
        </div>
      </form>

      {error && (
        <div
          role="alert"
          data-testid="guest-policy-error"
          className="mt-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          data-testid="guest-policy-notice"
          className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className="mt-5 border-t border-[#e7e7ea] pt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-[#111214]">
            <Mail className="h-3.5 w-3.5 text-[#5e6ad2]" />
            現在のゲスト招待
          </h3>
          <button
            type="button"
            onClick={() => void loadInvitations()}
            disabled={!canManage || invitationsLoading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            {invitationsLoading && <Loader2 className="h-3 w-3 animate-spin" />}
            再読み込み
          </button>
        </div>
        {!canManage ? (
          <p className="text-[0.6875rem] text-[#55565a]">
            招待の作成・再送・取消は sys_admin のみ実行できます。
          </p>
        ) : invitations.length === 0 ? (
          <p
            data-testid="guest-invitation-empty"
            className="rounded-xl border border-dashed border-[#d7d7dc] px-3 py-4 text-center text-[0.6875rem] text-[#55565a]"
          >
            ゲスト招待はまだありません。フォルダ権限画面または招待 API から作成できます。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-[0.6875rem]">
              <thead>
                <tr className="border-b border-[#e7e7ea] text-[#55565a]">
                  <th className="py-1.5 pr-3 font-medium">メール</th>
                  <th className="py-1.5 pr-3 font-medium">共有対象</th>
                  <th className="py-1.5 pr-3 font-medium">ロール</th>
                  <th className="py-1.5 pr-3 font-medium">状態</th>
                  <th className="py-1.5 pr-3 font-medium">有効期限</th>
                  <th className="py-1.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr
                    key={invitation.id}
                    data-testid="guest-invitation-row"
                    className="border-b border-[#f2f2f4] align-middle"
                  >
                    <td className="py-1.5 pr-3 text-[#111214]">
                      <span className="block font-medium">{invitation.email}</span>
                      <span className="block text-[0.625rem] text-[#55565a]">
                        {invitation.externalOrg ?? '外部組織未設定'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-[#3c3f46]">
                      {invitation.targetName ??
                        `${invitation.targetType}:${invitation.targetId.slice(0, 8)}`}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[0.625rem] text-[#3c3f46]">
                      {invitation.role}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={`inline-flex rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium ${
                          invitation.status === 'pending'
                            ? 'bg-blue-50 text-blue-700'
                            : invitation.status === 'accepted'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {guestInvitationStatusLabel(invitation.status)}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-[#3c3f46]">
                      {new Date(invitation.expiresAt).toLocaleString('ja-JP')}
                    </td>
                    <td className="py-1.5">
                      <div className="flex gap-1.5">
                        {invitation.status === 'pending' && (
                          <button
                            type="button"
                            data-testid={`guest-invitation-resend-${invitation.id}`}
                            onClick={() => void handleResend(invitation.id)}
                            disabled={Boolean(busyInvitationId)}
                            className="rounded border border-[#d7d7dc] bg-white px-1.5 py-0.5 text-[0.625rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
                          >
                            再送
                          </button>
                        )}
                        {(invitation.status === 'pending' ||
                          invitation.status === 'accepted') && (
                          <button
                            type="button"
                            data-testid={`guest-invitation-revoke-${invitation.id}`}
                            onClick={() => void handleRevoke(invitation.id)}
                            disabled={Boolean(busyInvitationId)}
                            className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-[0.625rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            取消
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {invitationError && (
          <div
            role="alert"
            className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-[0.625rem] text-red-700"
          >
            {invitationError}
          </div>
        )}
        {invitationNotice && (
          <div
            role="status"
            className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[0.625rem] text-emerald-800"
          >
            {invitationNotice}
          </div>
        )}
      </div>
    </section>
  );
}
