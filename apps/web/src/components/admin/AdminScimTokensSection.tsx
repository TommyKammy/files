'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCw,
  ShieldOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  buildScimEndpointUrl,
  canManageScimTokens,
  canRevokeScimToken,
  canRotateScimToken,
  canViewScimTokens,
  scimTokenPermissionNotice,
  scimTokenStatusBadgeClass,
  scimTokenStatusLabel,
} from '@/lib/admin-groups';
import {
  ApiClientError,
  createAdminScimToken,
  fetchAdminScimTokens,
  revokeAdminScimToken,
  rotateAdminScimToken,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminScimTokenListResponse,
  AdminScimTokenRow,
  AuthUser,
} from '@/types/files';

interface OneTimeToken {
  token: string;
  name: string;
  action: 'create' | 'rotate';
}

interface ConfirmAction {
  kind: 'rotate' | 'revoke';
  token: AdminScimTokenRow;
}

function TokenStatusBadge({ status }: { status: AdminScimTokenRow['status'] }) {
  return (
    <span
      data-testid="scim-token-status"
      data-status={status}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${scimTokenStatusBadgeClass(
        status
      )}`}
    >
      {scimTokenStatusLabel(status)}
    </span>
  );
}

export function AdminScimTokensSection({ user }: { user: AuthUser | null }) {
  const baseId = useId();
  const role = user?.role;
  const canView = canViewScimTokens(role);
  const canManage = canManageScimTokens(role);

  const [data, setData] = useState<AdminScimTokenListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState('/scim/v2');
  const requestIdRef = useRef(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createIssuer, setCreateIssuer] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [oneTime, setOneTime] = useState<OneTimeToken | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle'
  );

  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    if (!canView) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const response = await fetchAdminScimTokens();
      if (requestIdRef.current !== requestId) return;
      setData(response);
      setError(null);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'SCIM トークン一覧の読み込みに失敗しました'
      );
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    if (canView) void loadTokens();
  }, [canView, loadTokens]);

  useEffect(() => {
    setEndpoint(buildScimEndpointUrl(window.location.origin));
  }, []);

  if (!canView) return null;

  function openCreate() {
    if (!canManage) return;
    setCreateOpen(true);
    setCreateName('');
    setCreateIssuer('');
    setCreateBusy(false);
    setCreateError(null);
  }

  function closeCreate() {
    if (createBusy) return;
    setCreateOpen(false);
    setCreateError(null);
  }

  async function submitCreate() {
    if (createBusy || !canManage) return;
    const name = createName.trim();
    const idpIssuer = createIssuer.trim();
    if (!name) {
      setCreateError('トークン名を入力してください。');
      return;
    }
    if (!idpIssuer) {
      setCreateError('IdP Issuer を入力してください。');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const response = await createAdminScimToken({ name, idpIssuer });
      setCreateOpen(false);
      setNotice(response.notice);
      setOneTime({
        token: response.token ?? '',
        name: response.scimToken.name,
        action: 'create',
      });
      setCopyState('idle');
      void loadTokens();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError
          ? err.message
          : 'SCIM トークンの発行に失敗しました'
      );
    } finally {
      setCreateBusy(false);
    }
  }

  function openConfirm(kind: 'rotate' | 'revoke', token: AdminScimTokenRow) {
    if (!canManage) return;
    setConfirmAction({ kind, token });
    setConfirmError(null);
  }

  function closeConfirm() {
    if (confirmBusy) return;
    setConfirmAction(null);
    setConfirmError(null);
  }

  async function executeConfirm() {
    if (!confirmAction || confirmBusy || !canManage) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirmAction.kind === 'rotate') {
        const response = await rotateAdminScimToken(confirmAction.token.id);
        setConfirmAction(null);
        setNotice(response.notice);
        setOneTime({
          token: response.token ?? '',
          name: response.scimToken.name,
          action: 'rotate',
        });
        setCopyState('idle');
      } else {
        const response = await revokeAdminScimToken(confirmAction.token.id);
        setConfirmAction(null);
        setNotice(response.notice);
      }
      void loadTokens();
    } catch (err) {
      setConfirmError(
        err instanceof ApiClientError
          ? err.message
          : confirmAction.kind === 'rotate'
            ? 'SCIM トークンのローテーションに失敗しました'
            : 'SCIM トークンの失効に失敗しました'
      );
    } finally {
      setConfirmBusy(false);
    }
  }

  async function copyOneTimeToken() {
    if (!oneTime) return;
    try {
      await navigator.clipboard.writeText(oneTime.token);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  const tokens = data?.tokens ?? [];

  return (
    <section
      id="admin-scim-tokens"
      data-testid="admin-scim-tokens-section"
      aria-labelledby={`${baseId}-heading`}
      className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <KeyRound
            className="mt-0.5 h-4 w-4 text-[#5e6ad2]"
            aria-hidden="true"
          />
          <div>
            <h2
              id={`${baseId}-heading`}
              className="text-[0.875rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              SCIM トークン管理
            </h2>
            <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
              Okta / Entra ID の SCIM 2.0
              プロビジョニング用ベアラートークンを発行・ローテーション・失効します。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="scim-token-open-create"
            onClick={openCreate}
            disabled={!canManage}
            title={
              canManage
                ? 'SCIM トークンを発行'
                : 'SCIM トークン発行は sys_admin 専用です'
            }
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <KeyRound className="h-3 w-3" aria-hidden="true" />
            トークン発行
          </button>
          <button
            type="button"
            data-testid="scim-token-refresh"
            onClick={() => void loadTokens()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            再読み込み
          </button>
        </div>
      </header>

      <p
        id={`${baseId}-rbac`}
        data-testid="scim-token-rbac-notice"
        className={`mb-4 rounded-xl border px-3 py-2 text-[0.6875rem] ${
          canManage
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}
      >
        {scimTokenPermissionNotice(role)}
      </p>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] px-3 py-2 sm:col-span-2">
          <p className="text-[0.625rem] text-[#55565a]">
            SCIM エンドポイント Base URL
          </p>
          <p
            data-testid="scim-endpoint-base-url"
            className="break-all font-mono text-[0.6875rem] text-[#111214]"
          >
            {endpoint}
          </p>
          <p className="mt-0.5 text-[0.5625rem] text-[#8a8b90]">
            IdP 側にはこの URL を設定し、Authorization: Bearer
            に発行したトークンを指定してください。
          </p>
        </div>
        <div className="rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] px-3 py-2">
          <p className="text-[0.625rem] text-[#55565a]">
            有効 / 失効済み
          </p>
          <p className="text-[1rem] font-semibold text-[#111214]">
            {data?.activeCount ?? 0}
            <span className="mx-1 text-[0.625rem] font-normal text-[#55565a]">
              /
            </span>
            {data?.revokedCount ?? 0}
            <span className="ml-1 text-[0.625rem] font-normal text-[#55565a]">
              件
            </span>
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          data-testid="scim-token-notice"
          className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div
        role="region"
        aria-label="SCIM トークン一覧"
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-[#e7e7ea]"
      >
        <table
          data-testid="admin-scim-tokens-table"
          className="w-full min-w-[52rem] border-collapse text-left text-[0.6875rem]"
        >
          <caption className="sr-only">
            テナント内の SCIM ベアラートークン。ハッシュ値は表示されません。
          </caption>
          <thead className="bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                名前
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                IdP Issuer
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                最終利用
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                状態
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                作成日時
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && tokens.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[#55565a]">
                  <Loader2
                    className="mr-1.5 inline h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  SCIM トークンを読み込み中...
                </td>
              </tr>
            ) : tokens.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  data-testid="scim-token-empty"
                  className="px-3 py-6 text-center text-[#55565a]"
                >
                  SCIM トークンはまだ発行されていません。
                </td>
              </tr>
            ) : (
              tokens.map((token) => {
                const canRotate = canRotateScimToken(role, token);
                const canRevoke = canRevokeScimToken(role, token);
                return (
                  <tr
                    key={token.id}
                    data-testid="scim-token-row"
                    data-token-id={token.id}
                    className="border-t border-[#f2f2f4]"
                  >
                    <td className="px-3 py-2">
                      <p className="font-medium text-[#111214]">{token.name}</p>
                      <p className="font-mono text-[0.5625rem] text-[#8a8b90]">
                        {token.id}
                      </p>
                    </td>
                    <td className="max-w-[16rem] truncate px-3 py-2 font-mono text-[0.625rem] text-[#55565a]">
                      {token.idpIssuer}
                    </td>
                    <td
                      data-testid="scim-token-last-used"
                      className="px-3 py-2 text-[#55565a]"
                    >
                      {token.lastUsedAt
                        ? formatAuditDateTime(token.lastUsedAt)
                        : '未使用'}
                    </td>
                    <td className="px-3 py-2">
                      <TokenStatusBadge status={token.status} />
                      {token.revokedAt && (
                        <p className="mt-0.5 text-[0.5625rem] text-[#8a8b90]">
                          {formatAuditDateTime(token.revokedAt)}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[#55565a]">
                      {formatAuditDateTime(token.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          data-testid="scim-token-rotate-action"
                          disabled={!canRotate}
                          onClick={() => openConfirm('rotate', token)}
                          title={
                            canRotate
                              ? 'トークンをローテーション'
                              : token.status === 'revoked'
                                ? '失効済みトークンはローテーションできません'
                                : 'ローテーションは sys_admin 専用です'
                          }
                          className="inline-flex items-center gap-1 rounded border border-[#d7d7dc] bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <RotateCw
                            className="h-2.5 w-2.5"
                            aria-hidden="true"
                          />
                          ローテーション
                        </button>
                        <button
                          type="button"
                          data-testid="scim-token-revoke-action"
                          disabled={!canRevoke}
                          onClick={() => openConfirm('revoke', token)}
                          title={
                            canRevoke
                              ? 'トークンを即時失効'
                              : token.status === 'revoked'
                                ? '既に失効済みです'
                                : '失効は sys_admin 専用です'
                          }
                          className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <ShieldOff
                            className="h-2.5 w-2.5"
                            aria-hidden="true"
                          />
                          失効
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <ModalShell
          label="SCIM トークンを発行"
          labelledBy={`${baseId}-create-heading`}
          onClose={closeCreate}
          className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="scim-token-create-modal">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <div>
                <h3
                  id={`${baseId}-create-heading`}
                  className="text-sm font-semibold text-slate-900"
                >
                  SCIM トークンを発行
                </h3>
                <p className="mt-0.5 text-[0.6875rem] text-slate-500">
                  D1 には SHA-256 ハッシュのみを保存します。平文は次の画面で 1
                  回だけ表示されます。
                </p>
              </div>
              <button
                type="button"
                data-testid="scim-token-create-close"
                aria-label="SCIM トークン発行を閉じる"
                onClick={closeCreate}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <form
              className="space-y-3 px-5 py-4 text-xs"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate();
              }}
            >
              <label className="block text-[0.6875rem] font-medium text-slate-700">
                トークン名
                <input
                  type="text"
                  required
                  data-testid="scim-token-create-name"
                  data-autofocus
                  value={createName}
                  maxLength={120}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="例: Okta Production"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>
              <label className="block text-[0.6875rem] font-medium text-slate-700">
                IdP Issuer
                <input
                  type="text"
                  required
                  data-testid="scim-token-create-issuer"
                  value={createIssuer}
                  maxLength={320}
                  onChange={(event) => setCreateIssuer(event.target.value)}
                  placeholder="https://idp.example.com/oauth2/default"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>
              {createError && (
                <div
                  role="alert"
                  data-testid="scim-token-create-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {createError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeCreate}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  閉じる
                </button>
                <button
                  type="submit"
                  data-testid="scim-token-create-submit"
                  disabled={createBusy}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                >
                  {createBusy && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  発行
                </button>
              </div>
            </form>
          </div>
        </ModalShell>
      )}

      {oneTime && (
        <ModalShell
          label="SCIM トークン（一度きり表示）"
          labelledBy={`${baseId}-onetime-heading`}
          onClose={() => setOneTime(null)}
          className="w-full max-w-2xl overflow-hidden rounded-2xl border border-amber-300 bg-white shadow-2xl"
        >
          <div data-testid="scim-token-onetime-dialog">
            <div className="border-b border-amber-200 bg-amber-50 px-5 py-3">
              <h3
                id={`${baseId}-onetime-heading`}
                className="text-sm font-semibold text-amber-950"
              >
                {oneTime.action === 'create'
                  ? 'SCIM トークンを発行しました'
                  : 'SCIM トークンをローテーションしました'}
              </h3>
              <p className="mt-0.5 text-[0.6875rem] text-amber-900">
                {oneTime.name} — この平文トークンはこの画面を閉じると再表示できません。
              </p>
            </div>
            <div className="space-y-3 px-5 py-4 text-xs">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  readOnly
                  data-testid="scim-token-onetime-value"
                  value={oneTime.token}
                  onFocus={(event) => event.currentTarget.select()}
                  spellCheck={false}
                  className="h-10 min-w-0 flex-1 rounded-md border border-amber-300 bg-amber-50/50 px-2 font-mono text-[0.6875rem] text-slate-900"
                />
                <button
                  type="button"
                  data-testid="scim-token-onetime-copy"
                  onClick={() => void copyOneTimeToken()}
                  className="inline-flex h-10 items-center justify-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2]"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  コピー
                </button>
              </div>
              {copyState === 'copied' && (
                <p role="status" className="text-[0.6875rem] text-emerald-700">
                  クリップボードにコピーしました。
                </p>
              )}
              {copyState === 'failed' && (
                <p role="alert" className="text-[0.6875rem] text-red-700">
                  自動コピーに失敗しました。入力欄を選択してコピーしてください。
                </p>
              )}
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-900">
                IdP の SCIM 設定にこのトークンを登録してください。監査ログ・D1
                には平文を保存しません。
              </p>
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="scim-token-onetime-close"
                  onClick={() => setOneTime(null)}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  閉じる
                </button>
              </div>
            </div>
          </div>
        </ModalShell>
      )}

      {confirmAction && (
        <ModalShell
          label={
            confirmAction.kind === 'rotate'
              ? 'SCIM トークンをローテーション'
              : 'SCIM トークンを失効'
          }
          labelledBy={`${baseId}-confirm-heading`}
          onClose={closeConfirm}
          className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="scim-token-confirm-modal">
            <div className="border-b border-slate-200 px-5 py-3">
              <h3
                id={`${baseId}-confirm-heading`}
                data-testid="scim-token-confirm-title"
                className="text-sm font-semibold text-slate-900"
              >
                {confirmAction.kind === 'rotate'
                  ? `トークン「${confirmAction.token.name}」をローテーションしますか？`
                  : `トークン「${confirmAction.token.name}」を失効しますか？`}
              </h3>
              <p className="mt-1 break-all font-mono text-[0.625rem] text-slate-500">
                {confirmAction.token.idpIssuer}
              </p>
            </div>
            <div className="space-y-3 px-5 py-4 text-xs text-slate-700">
              <p>
                {confirmAction.kind === 'rotate'
                  ? '旧トークンは即時失効し、同じ名前・IdP Issuer で新しいトークンを発行します。新しい平文トークンは次の画面で 1 回だけ表示されます。'
                  : 'SCIM プロビジョニングは直ちに 401 で拒否されます。失効済みトークンを再度失効しても成功扱いになります。'}
              </p>
              {confirmError && (
                <div
                  role="alert"
                  data-testid="scim-token-confirm-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {confirmError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="scim-token-confirm-cancel"
                  disabled={confirmBusy}
                  onClick={closeConfirm}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  data-testid="scim-token-confirm-execute"
                  disabled={confirmBusy}
                  onClick={() => void executeConfirm()}
                  className={`inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs font-medium text-white disabled:opacity-50 ${
                    confirmAction.kind === 'revoke'
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-[#5e6ad2] hover:bg-[#4f5ac2]'
                  }`}
                >
                  {confirmBusy && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {confirmAction.kind === 'rotate' ? '実行' : '失効する'}
                </button>
              </div>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
