'use client';

import {
  AlertTriangle,
  Loader2,
  Radio,
  Save,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  readSiemEvents,
  SIEM_EVENT_CATEGORY_OPTIONS,
  validateSiemUrlClient,
} from '@/lib/admin-compliance';
import {
  ApiClientError,
  fetchAdminSiem,
  testAdminSiem,
  updateAdminSiem,
} from '@/lib/files-api';
import type { AdminSiemSettings } from '@/types/files';

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    return err.code ? `${err.message} (${err.code})` : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function AdminSiemSettingsSection({
  canManage,
}: {
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<AdminSiemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<string[]>([
    'security_blocked',
    'admin_mutation',
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const response = await fetchAdminSiem();
        if (cancelled) return;
        setSettings(response.siem);
        setEnabled(response.siem.enabled);
        setUrl(response.siem.url ?? '');
        setEvents(readSiemEvents(response.siem.events));
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err, 'SIEM 設定の読み込みに失敗しました'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleEvent(value: string, checked: boolean) {
    setEvents((current) =>
      checked
        ? current.includes(value)
          ? current
          : [...current, value]
        : current.filter((event) => event !== value)
    );
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || saving) return;
    setError(null);
    setNotice(null);

    if (enabled || url.trim()) {
      const validation = validateSiemUrlClient(url);
      if (!validation.ok) {
        setError(validation.error ?? 'SIEM Webhook URL が不正です。');
        return;
      }
    }
    if (enabled && !settings?.secretConfigured && !secret.trim()) {
      setError('有効化するには SIEM Webhook シークレットを入力してください。');
      return;
    }

    setSaving(true);
    try {
      const response = await updateAdminSiem({
        enabled,
        url: url.trim() || null,
        events,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      setSettings(response.siem);
      setEnabled(response.siem.enabled);
      setUrl(response.siem.url ?? '');
      setEvents(readSiemEvents(response.siem.events));
      setSecret('');
      setNotice('SIEM Webhook 設定を保存しました');
    } catch (err) {
      setError(errorText(err, 'SIEM 設定の保存に失敗しました'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!canManage || testing) return;
    setError(null);
    setNotice(null);
    setTesting(true);
    try {
      const result = await testAdminSiem();
      if (result.ok) {
        setNotice(
          `テストイベントを送信しました (HTTP ${result.status ?? 'OK'})`
        );
      } else {
        setError(
          `テスト送信に失敗しました${
            result.status ? ` (HTTP ${result.status})` : ''
          }: ${result.error ?? '配信先を確認してください'}`
        );
      }
    } catch (err) {
      setError(errorText(err, 'SIEM テスト送信に失敗しました'));
    } finally {
      setTesting(false);
    }
  }

  return (
    <section
      aria-labelledby="admin-siem-heading"
      data-testid="admin-siem-section"
      className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="admin-siem-heading"
            className="flex items-center gap-2 text-sm font-semibold text-slate-900"
          >
            <Radio className="h-4 w-4 text-[#5e6ad2]" />
            SIEM Webhook 連携
          </h2>
          <p className="mt-1 text-[0.6875rem] text-[#55565a]">
            管理者イベントとセキュリティブロックを HMAC-SHA256 署名付きで
            https エンドポイントへ非同期配信します。シークレットは暗号化保存され、
            再表示されません。
          </p>
        </div>
        {settings?.secretConfigured && (
          <span
            data-testid="admin-siem-secret-configured"
            className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[0.625rem] font-medium text-emerald-700"
          >
            <ShieldCheck className="h-3 w-3" />
            シークレット設定済み
          </span>
        )}
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-[0.75rem] text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          SIEM 設定を読み込み中...
        </div>
      ) : (
        <form onSubmit={handleSave} className="mt-4 space-y-3">
          <label className="inline-flex items-center gap-2 text-[0.75rem] font-medium text-slate-700">
            <input
              data-testid="admin-siem-enabled"
              type="checkbox"
              checked={enabled}
              disabled={!canManage}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 accent-[#5e6ad2]"
            />
            SIEM Webhook 配信を有効化
          </label>

          <label className="block text-[0.75rem]">
            <span className="font-medium text-slate-700">Webhook URL (https のみ)</span>
            <input
              data-testid="admin-siem-url"
              type="url"
              inputMode="url"
              value={url}
              disabled={!canManage}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://siem.example.com/ingest/files"
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 font-mono text-[0.75rem]"
            />
            <span className="mt-1 block text-[0.625rem] text-[#6b6f76]">
              localhost・*.local・*.internal・プライベート/ループバック/リンクローカル
              IP は API 側で拒否されます。リダイレクトは追跡しません。
            </span>
          </label>

          <label className="block text-[0.75rem]">
            <span className="font-medium text-slate-700">
              共有シークレット {settings?.secretConfigured ? '(変更する場合のみ入力)' : ''}
            </span>
            <input
              data-testid="admin-siem-secret"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={secret}
              disabled={!canManage}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={settings?.secretConfigured ? '••••••••' : '32 文字以上の推奨'}
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 font-mono text-[0.75rem]"
            />
          </label>

          <fieldset className="space-y-2">
            <legend className="text-[0.75rem] font-medium text-slate-700">
              配信イベント
            </legend>
            <div className="flex flex-wrap gap-4">
              {SIEM_EVENT_CATEGORY_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="inline-flex items-center gap-2 text-[0.75rem] text-slate-700"
                >
                  <input
                    data-testid={`admin-siem-event-${option.value}`}
                    type="checkbox"
                    checked={events.includes(option.value)}
                    disabled={!canManage}
                    onChange={(event) =>
                      toggleEvent(option.value, event.target.checked)
                    }
                    className="h-4 w-4 rounded border-slate-300 accent-[#5e6ad2]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {error && (
            <p
              role="alert"
              data-testid="admin-siem-error"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              data-testid="admin-siem-notice"
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
            >
              {notice}
            </p>
          )}

          {!canManage && (
            <p className="text-[0.625rem] text-amber-700">
              sec_admin は閲覧のみ可能です。変更・テスト送信は sys_admin が行ってください。
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              data-testid="admin-siem-save"
              disabled={!canManage || saving}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              SIEM 設定を保存
            </button>
            <button
              type="button"
              data-testid="admin-siem-test"
              disabled={!canManage || testing || !settings?.secretConfigured}
              onClick={() => void handleTest()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#d7d7dc] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f5f5f7] disabled:opacity-50"
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              テストイベント送信
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
