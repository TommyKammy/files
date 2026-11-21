'use client';

import {
  Activity,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldOff,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  API_TOKEN_SCOPES,
  ApiClientError,
  WEBHOOK_EVENT_TYPES,
  createAdminWebhook,
  createApiToken,
  deleteAdminWebhook,
  fetchAdminWebhooks,
  fetchApiTokens,
  fetchWebhookDeliveries,
  revokeApiToken,
  testAdminWebhook,
  updateAdminWebhook,
  validateWebhookClientInput,
  type ApiTokenItem,
  type ApiTokenScope,
  type TenantWebhookItem,
  type WebhookDeliveryItem,
  type WebhookEventType,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type { AuthUser } from '@/types/files';

export function AdminWebhooksTokensSection({ user }: { user: AuthUser | null }) {
  const canManageWebhooks = user?.role === 'sys_admin';

  // Webhooks state
  const [webhooks, setWebhooks] = useState<TenantWebhookItem[]>([]);
  const [whLoading, setWhLoading] = useState(false);
  const [whError, setWhError] = useState<string | null>(null);
  const [whNotice, setWhNotice] = useState<string | null>(null);
  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whEvents, setWhEvents] = useState<WebhookEventType[]>([
    'file.uploaded',
    'file.deleted',
  ]);
  const [whCreating, setWhCreating] = useState(false);
  const [oneTimeSecret, setOneTimeSecret] = useState<{
    name: string;
    secret: string;
  } | null>(null);
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryItem[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  // API Tokens state
  const [tokens, setTokens] = useState<ApiTokenItem[]>([]);
  const [tokLoading, setTokLoading] = useState(false);
  const [tokError, setTokError] = useState<string | null>(null);
  const [tokNotice, setTokNotice] = useState<string | null>(null);
  const [tokName, setTokName] = useState('');
  const [tokScopes, setTokScopes] = useState<ApiTokenScope[]>(['files:read']);
  const [tokExpiresDays, setTokExpiresDays] = useState<string>('90');
  const [tokCreating, setTokCreating] = useState(false);
  const [oneTimeToken, setOneTimeToken] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadWebhooks = useCallback(async () => {
    setWhLoading(true);
    setWhError(null);
    try {
      const res = await fetchAdminWebhooks();
      setWebhooks(res.webhooks);
    } catch (err) {
      setWhError(
        err instanceof ApiClientError
          ? err.message
          : 'Webhook 一覧の取得に失敗しました。'
      );
    } finally {
      setWhLoading(false);
    }
  }, []);

  const loadTokens = useCallback(async () => {
    setTokLoading(true);
    setTokError(null);
    try {
      const res = await fetchApiTokens();
      setTokens(res.tokens);
    } catch (err) {
      setTokError(
        err instanceof ApiClientError
          ? err.message
          : 'API トークン一覧の取得に失敗しました。'
      );
    } finally {
      setTokLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWebhooks();
    void loadTokens();
  }, [loadWebhooks, loadTokens]);

  async function handleCopy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      setCopiedKey(null);
    }
  }

  function toggleWebhookEvent(ev: WebhookEventType) {
    setWhEvents((prev) =>
      prev.includes(ev) ? prev.filter((item) => item !== ev) : [...prev, ev]
    );
  }

  async function handleCreateWebhook(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validateWebhookClientInput({
      name: whName,
      url: whUrl,
      events: whEvents,
    });
    if (validationError) {
      setWhError(validationError);
      return;
    }

    setWhCreating(true);
    setWhError(null);
    setWhNotice(null);
    try {
      const res = await createAdminWebhook({
        name: whName.trim(),
        url: whUrl.trim(),
        events: whEvents,
      });
      if (res.secret) {
        setOneTimeSecret({ name: res.webhook.name, secret: res.secret });
      }
      setWhName('');
      setWhUrl('');
      setWhNotice(`Webhook「${res.webhook.name}」を作成しました。`);
      await loadWebhooks();
    } catch (err) {
      setWhError(
        err instanceof ApiClientError
          ? err.message
          : 'Webhook の作成に失敗しました。'
      );
    } finally {
      setWhCreating(false);
    }
  }

  async function handleToggleWebhookEnabled(wh: TenantWebhookItem) {
    setWhError(null);
    try {
      await updateAdminWebhook(wh.id, { enabled: !wh.enabled });
      await loadWebhooks();
    } catch (err) {
      setWhError(
        err instanceof ApiClientError
          ? err.message
          : 'Webhook の更新に失敗しました。'
      );
    }
  }

  async function handleDeleteWebhook(wh: TenantWebhookItem) {
    setWhError(null);
    setWhNotice(null);
    try {
      await deleteAdminWebhook(wh.id);
      if (selectedWebhookId === wh.id) {
        setSelectedWebhookId(null);
        setDeliveries([]);
      }
      setWhNotice(`Webhook「${wh.name}」を削除しました。`);
      await loadWebhooks();
    } catch (err) {
      setWhError(
        err instanceof ApiClientError
          ? err.message
          : 'Webhook の削除に失敗しました。'
      );
    }
  }

  async function handleViewDeliveries(webhookId: string) {
    if (selectedWebhookId === webhookId) {
      setSelectedWebhookId(null);
      setDeliveries([]);
      return;
    }
    setSelectedWebhookId(webhookId);
    setDeliveriesLoading(true);
    try {
      const res = await fetchWebhookDeliveries(webhookId);
      setDeliveries(res.deliveries);
    } catch (err) {
      setWhError(
        err instanceof ApiClientError
          ? err.message
          : '配信ログの取得に失敗しました。'
      );
    } finally {
      setDeliveriesLoading(false);
    }
  }

  async function handleTestWebhook(wh: TenantWebhookItem) {
    setTestingId(wh.id);
    setWhError(null);
    setWhNotice(null);
    try {
      const res = await testAdminWebhook(wh.id);
      setWhNotice(
        res.ok
          ? `テスト送信に成功しました (HTTP ${res.delivery.statusCode ?? '-'})`
          : `テスト送信に失敗しました (${res.delivery.errorMessage ?? 'エラー'})`
      );
      if (selectedWebhookId === wh.id) {
        const logs = await fetchWebhookDeliveries(wh.id);
        setDeliveries(logs.deliveries);
      }
    } catch (err) {
      setWhError(
        err instanceof ApiClientError
          ? err.message
          : 'テスト送信に失敗しました。'
      );
    } finally {
      setTestingId(null);
    }
  }

  function toggleTokenScope(scope: ApiTokenScope) {
    setTokScopes((prev) =>
      prev.includes(scope)
        ? prev.filter((item) => item !== scope)
        : [...prev, scope]
    );
  }

  async function handleCreateToken(e: React.FormEvent) {
    e.preventDefault();
    if (!tokName.trim()) {
      setTokError('トークン名を入力してください。');
      return;
    }
    if (tokScopes.length === 0) {
      setTokError('少なくとも 1 つのスコープを選択してください。');
      return;
    }
    const parsedDays = tokExpiresDays.trim()
      ? Number.parseInt(tokExpiresDays.trim(), 10)
      : undefined;
    if (
      parsedDays !== undefined &&
      (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650)
    ) {
      setTokError('有効期限は 1〜3650 日の整数で指定してください。');
      return;
    }

    setTokCreating(true);
    setTokError(null);
    setTokNotice(null);
    try {
      const res = await createApiToken({
        name: tokName.trim(),
        scopes: tokScopes,
        ...(parsedDays !== undefined ? { expiresInDays: parsedDays } : {}),
      });
      setOneTimeToken({ name: res.apiToken.name, token: res.token });
      setTokName('');
      setTokNotice(`API トークン「${res.apiToken.name}」を発行しました。`);
      await loadTokens();
    } catch (err) {
      setTokError(
        err instanceof ApiClientError
          ? err.message
          : 'API トークンの発行に失敗しました。'
      );
    } finally {
      setTokCreating(false);
    }
  }

  async function handleRevokeToken(token: ApiTokenItem) {
    setTokError(null);
    setTokNotice(null);
    try {
      await revokeApiToken(token.id);
      setTokNotice(`API トークン「${token.name}」を失効しました。`);
      await loadTokens();
    } catch (err) {
      setTokError(
        err instanceof ApiClientError
          ? err.message
          : 'API トークンの失効に失敗しました。'
      );
    }
  }

  return (
    <div
      data-testid="admin-webhooks-tokens-section"
      className="space-y-4"
    >
      {/* Webhooks Panel */}
      <section className="rounded-2xl border border-[#e7e7ea] bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Webhook className="h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
            <div>
              <h3 className="text-[0.875rem] font-semibold text-[#111214]">
                イベント Webhook (HMAC-SHA256)
              </h3>
              <p className="text-[0.6875rem] text-[#55565a]">
                ファイル・フォルダ・共有イベントを指定の HTTPS エンドポイントへ署名付きで通知します。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadWebhooks()}
            disabled={whLoading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${whLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            更新
          </button>
        </div>

        {whError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.75rem] text-red-700">
            {whError}
          </div>
        )}
        {whNotice && (
          <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.75rem] text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{whNotice}</span>
          </div>
        )}

        {oneTimeSecret && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-[0.75rem] font-semibold text-amber-900">
              署名シークレット（{oneTimeSecret.name}）— この画面を閉じると再表示できません
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1 font-mono text-[0.6875rem] text-[#111214]">
                {oneTimeSecret.secret}
              </code>
              <button
                type="button"
                onClick={() => void handleCopy('secret', oneTimeSecret.secret)}
                className="inline-flex h-7 items-center gap-1 rounded border border-amber-300 bg-white px-2 text-[0.6875rem] font-medium text-amber-900 hover:bg-amber-100"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                {copiedKey === 'secret' ? 'コピー済み' : 'コピー'}
              </button>
            </div>
          </div>
        )}

        {canManageWebhooks && (
          <form
            onSubmit={(e) => void handleCreateWebhook(e)}
            className="mt-3 space-y-2.5 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                type="text"
                placeholder="Webhook 名 (例: Audit Collector)"
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                className="h-8 rounded-md border border-[#d6d7dc] bg-white px-2.5 text-[0.75rem] text-[#111214]"
              />
              <input
                type="url"
                placeholder="https://hooks.example.com/files"
                value={whUrl}
                onChange={(e) => setWhUrl(e.target.value)}
                className="h-8 rounded-md border border-[#d6d7dc] bg-white px-2.5 text-[0.75rem] text-[#111214]"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {WEBHOOK_EVENT_TYPES.map((ev) => {
                const checked = whEvents.includes(ev);
                return (
                  <label
                    key={ev}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.6875rem] ${
                      checked
                        ? 'border-[#5e6ad2] bg-[#eef0fb] font-medium text-[#3f4a9e]'
                        : 'border-[#e1e1e4] bg-white text-[#55565a]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleWebhookEvent(ev)}
                      className="sr-only"
                    />
                    {ev}
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={whCreating}
                className="inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-[0.6875rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {whCreating ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="h-3 w-3" aria-hidden="true" />
                )}
                Webhook を追加
              </button>
            </div>
          </form>
        )}

        <div className="mt-3 space-y-2">
          {webhooks.length === 0 ? (
            <p className="text-[0.75rem] text-[#75767c]">
              登録済みの Webhook はありません。
            </p>
          ) : (
            webhooks.map((wh) => (
              <div
                key={wh.id}
                className="rounded-xl border border-[#e7e7ea] bg-white p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[0.8125rem] font-semibold text-[#111214]">
                        {wh.name}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${
                          wh.enabled
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-[#e1e1e4] bg-[#f4f4f6] text-[#55565a]'
                        }`}
                      >
                        {wh.enabled ? '有効' : '無効'}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-[#55565a]">
                      {wh.url}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {wh.events.map((ev) => (
                        <span
                          key={ev}
                          className="rounded border border-[#e1e1e4] bg-[#f9f9fa] px-1.5 py-0.5 text-[0.625rem] text-[#55565a]"
                        >
                          {ev}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleViewDeliveries(wh.id)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 text-[0.6875rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
                    >
                      <Activity className="h-3 w-3" aria-hidden="true" />
                      配信ログ
                    </button>
                    {canManageWebhooks && (
                      <>
                        <button
                          type="button"
                          disabled={testingId === wh.id}
                          onClick={() => void handleTestWebhook(wh)}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d9ddf8] bg-white px-2 text-[0.6875rem] font-medium text-[#3f4a9e] hover:bg-[#eef0fb] disabled:opacity-50"
                        >
                          <Send className="h-3 w-3" aria-hidden="true" />
                          テスト送信
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleWebhookEnabled(wh)}
                          className="inline-flex h-7 items-center rounded-md border border-[#e1e1e4] bg-white px-2 text-[0.6875rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
                        >
                          {wh.enabled ? '無効化' : '有効化'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteWebhook(wh)}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-red-200 bg-white px-2 text-[0.6875rem] font-medium text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          削除
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {selectedWebhookId === wh.id && (
                  <div className="mt-2.5 border-t border-[#ececef] pt-2.5">
                    <p className="text-[0.6875rem] font-semibold text-[#3c3f46]">
                      直近の配信ログ (最大 50 件)
                    </p>
                    {deliveriesLoading ? (
                      <p className="mt-1 text-[0.6875rem] text-[#75767c]">
                        読み込み中...
                      </p>
                    ) : deliveries.length === 0 ? (
                      <p className="mt-1 text-[0.6875rem] text-[#75767c]">
                        配信履歴はまだありません。
                      </p>
                    ) : (
                      <div className="mt-1.5 max-h-48 space-y-1 overflow-y-auto">
                        {deliveries.map((d) => (
                          <div
                            key={d.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded bg-[#f9f9fa] px-2.5 py-1 text-[0.6875rem]"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`font-semibold ${
                                  d.ok ? 'text-emerald-700' : 'text-red-600'
                                }`}
                              >
                                {d.ok ? 'OK' : 'FAIL'}
                              </span>
                              <span className="font-mono text-[#111214]">
                                {d.eventType}
                              </span>
                              <span className="text-[#55565a]">
                                HTTP {d.statusCode ?? '-'}
                              </span>
                              {d.errorMessage && (
                                <span className="text-red-600">
                                  {d.errorMessage}
                                </span>
                              )}
                            </div>
                            <span className="text-[#75767c]">
                              {formatAuditDateTime(d.createdAt)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Scoped API Tokens Panel */}
      <section className="rounded-2xl border border-[#e7e7ea] bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
            <div>
              <h3 className="text-[0.875rem] font-semibold text-[#111214]">
                スコープ付き API トークン
              </h3>
              <p className="text-[0.6875rem] text-[#55565a]">
                Bearer fls_... 認証用の個人 API トークンを発行・失効します。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadTokens()}
            disabled={tokLoading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${tokLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            更新
          </button>
        </div>

        {tokError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.75rem] text-red-700">
            {tokError}
          </div>
        )}
        {tokNotice && (
          <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.75rem] text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{tokNotice}</span>
          </div>
        )}

        {oneTimeToken && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-[0.75rem] font-semibold text-amber-900">
              API トークン（{oneTimeToken.name}）— この画面を閉じると再表示できません
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1 font-mono text-[0.6875rem] text-[#111214]">
                {oneTimeToken.token}
              </code>
              <button
                type="button"
                onClick={() => void handleCopy('token', oneTimeToken.token)}
                className="inline-flex h-7 items-center gap-1 rounded border border-amber-300 bg-white px-2 text-[0.6875rem] font-medium text-amber-900 hover:bg-amber-100"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                {copiedKey === 'token' ? 'コピー済み' : 'コピー'}
              </button>
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => void handleCreateToken(e)}
          className="mt-3 space-y-2.5 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              type="text"
              placeholder="トークン名 (例: CLI Sync)"
              value={tokName}
              onChange={(e) => setTokName(e.target.value)}
              className="h-8 rounded-md border border-[#d6d7dc] bg-white px-2.5 text-[0.75rem] text-[#111214]"
            />
            <input
              type="number"
              min={1}
              max={3650}
              placeholder="有効期限 (日数、空欄で無期限)"
              value={tokExpiresDays}
              onChange={(e) => setTokExpiresDays(e.target.value)}
              className="h-8 rounded-md border border-[#d6d7dc] bg-white px-2.5 text-[0.75rem] text-[#111214]"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {API_TOKEN_SCOPES.map((scope) => {
              const checked = tokScopes.includes(scope);
              return (
                <label
                  key={scope}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.6875rem] ${
                    checked
                      ? 'border-[#5e6ad2] bg-[#eef0fb] font-medium text-[#3f4a9e]'
                      : 'border-[#e1e1e4] bg-white text-[#55565a]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTokenScope(scope)}
                    className="sr-only"
                  />
                  {scope}
                </label>
              );
            })}
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={tokCreating}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-[0.6875rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {tokCreating ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-3 w-3" aria-hidden="true" />
              )}
              トークンを発行
            </button>
          </div>
        </form>

        <div className="mt-3 space-y-2">
          {tokens.length === 0 ? (
            <p className="text-[0.75rem] text-[#75767c]">
              発行済みの API トークンはありません。
            </p>
          ) : (
            tokens.map((tok) => (
              <div
                key={tok.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e7e7ea] bg-white p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[0.8125rem] font-semibold text-[#111214]">
                      {tok.name}
                    </span>
                    <code className="rounded bg-[#f4f4f6] px-1.5 py-0.5 font-mono text-[0.6875rem] text-[#3c3f46]">
                      {tok.tokenPrefix}...
                    </code>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${
                        tok.status === 'active'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-[#e1e1e4] bg-[#f4f4f6] text-[#55565a]'
                      }`}
                    >
                      {tok.status === 'active'
                        ? '有効'
                        : tok.status === 'revoked'
                          ? '失効済み'
                          : '期限切れ'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.625rem] text-[#55565a]">
                    {tok.scopes.map((s) => (
                      <span
                        key={s}
                        className="rounded border border-[#e1e1e4] bg-[#f9f9fa] px-1.5 py-0.5"
                      >
                        {s}
                      </span>
                    ))}
                    {tok.expiresAt && (
                      <span>有効期限: {formatAuditDateTime(tok.expiresAt)}</span>
                    )}
                    {tok.lastUsedAt && (
                      <span>最終利用: {formatAuditDateTime(tok.lastUsedAt)}</span>
                    )}
                  </div>
                </div>
                {tok.status === 'active' && (
                  <button
                    type="button"
                    onClick={() => void handleRevokeToken(tok)}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-red-200 bg-white px-2 text-[0.6875rem] font-medium text-red-600 hover:bg-red-50"
                  >
                    <ShieldOff className="h-3 w-3" aria-hidden="true" />
                    失効
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
