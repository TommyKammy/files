'use client';

import { Loader2, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  DLP_ACTION_LABELS,
  DLP_PATTERN_LABELS,
  SECURITY_ALERT_TYPE_LABELS,
  createDlpRule,
  deleteDlpRule,
  describeAlertDetails,
  fetchDlpRules,
  fetchSecurityAlerts,
  severityTone,
  testDlpRule,
  updateDlpRule,
  updateSecurityAlertStatus,
  validateDlpRuleInput,
  type DlpAction,
  type DlpPatternType,
  type DlpRule,
  type SecurityAlert,
  type SecurityAlertStatus,
} from '@/lib/files-api/dlp-alerts';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '操作に失敗しました';
}

export function AdminDlpAlertsSection() {
  const [rules, setRules] = useState<DlpRule[]>([]);
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [patternType, setPatternType] = useState<DlpPatternType>('builtin_credit_card');
  const [customPattern, setCustomPattern] = useState('');
  const [action, setAction] = useState<DlpAction>('alert');
  const [sampleText, setSampleText] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [r, a] = await Promise.all([
        fetchDlpRules(),
        fetchSecurityAlerts(showAll ? 'all' : 'open'),
      ]);
      setRules(r.rules);
      setAlerts(a.alerts);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const onCreate = () => {
    const input = {
      name,
      patternType,
      customPattern: patternType === 'custom_regex' ? customPattern : undefined,
      action,
    };
    const invalid = validateDlpRuleInput(input);
    if (invalid) {
      setError(invalid);
      return;
    }
    void run(async () => {
      await createDlpRule(input);
      setName('');
      setCustomPattern('');
    });
  };

  const onTest = async () => {
    setError(null);
    setTestResult(null);
    try {
      const res = await testDlpRule({
        patternType,
        customPattern: patternType === 'custom_regex' ? customPattern : undefined,
        sampleText,
      });
      setTestResult(res.matched ? `一致: ${res.matchCount} 件` : '一致なし');
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const setStatus = (id: string, status: SecurityAlertStatus) =>
    void run(() => updateSecurityAlertStatus(id, status));

  return (
    <section
      aria-labelledby="admin-dlp-heading"
      data-testid="admin-dlp-alerts"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-red-600" aria-hidden />
        <h2 id="admin-dlp-heading" className="text-sm font-semibold text-slate-900">
          DLP ルールとセキュリティアラート
        </h2>
      </div>
      <p className="text-[0.6875rem] text-[#55565a]">
        検知された個人情報の値そのものは保存されません (件数・ルール名のみ記録)。
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2" data-testid="dlp-rule-form">
        <input
          aria-label="ルール名"
          className="rounded border border-slate-300 px-2 py-1 text-xs"
          placeholder="ルール名"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="検知パターン"
          className="rounded border border-slate-300 px-2 py-1 text-xs"
          value={patternType}
          onChange={(e) => setPatternType(e.target.value as DlpPatternType)}
        >
          {Object.entries(DLP_PATTERN_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {patternType === 'custom_regex' && (
          <input
            aria-label="カスタム正規表現"
            className="rounded border border-slate-300 px-2 py-1 font-mono text-xs sm:col-span-2"
            placeholder="例: PROJ-\d{4}"
            value={customPattern}
            maxLength={120}
            onChange={(e) => setCustomPattern(e.target.value)}
          />
        )}
        <select
          aria-label="アクション"
          className="rounded border border-slate-300 px-2 py-1 text-xs"
          value={action}
          onChange={(e) => setAction(e.target.value as DlpAction)}
        >
          {Object.entries(DLP_ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onCreate}
          className="rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white"
        >
          ルールを追加
        </button>
        <textarea
          aria-label="テスト用サンプルテキスト"
          className="rounded border border-slate-300 px-2 py-1 text-xs sm:col-span-2"
          placeholder="ドライランで検証するサンプルテキスト (保存されません)"
          rows={2}
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
        />
        <div className="flex items-center gap-2 sm:col-span-2">
          <button
            type="button"
            onClick={() => void onTest()}
            className="rounded border border-slate-300 px-3 py-1 text-xs"
          >
            ドライランテスト
          </button>
          {testResult && (
            <span data-testid="dlp-test-result" className="text-xs text-slate-700">
              {testResult}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-label="読み込み中" />
      ) : (
        <>
          <ul className="space-y-1" data-testid="dlp-rule-list">
            {rules.length === 0 && <li className="text-xs text-slate-500">ルールはありません</li>}
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1 text-xs"
              >
                <span>
                  <strong>{rule.name}</strong> — {DLP_PATTERN_LABELS[rule.patternType]} /{' '}
                  {DLP_ACTION_LABELS[rule.action]}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void run(() => updateDlpRule(rule.id, { enabled: !rule.enabled }))}
                  >
                    {rule.enabled ? '無効化' : '有効化'}
                  </button>
                  <button
                    type="button"
                    className="text-red-700 underline"
                    onClick={() => void run(() => deleteDlpRule(rule.id))}
                  >
                    削除
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-800">セキュリティアラート</h3>
            <label className="flex items-center gap-1 text-[0.6875rem] text-slate-600">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              対応済みも表示
            </label>
          </div>
          <ul className="space-y-1" data-testid="security-alert-list">
            {alerts.length === 0 && <li className="text-xs text-slate-500">アラートはありません</li>}
            {alerts.map((alert) => (
              <li
                key={alert.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1 text-xs"
              >
                <span>
                  <span
                    className={`mr-2 rounded border px-1.5 py-0.5 text-[0.625rem] ${severityTone(alert.severity)}`}
                  >
                    {alert.severity}
                  </span>
                  {SECURITY_ALERT_TYPE_LABELS[alert.alertType]}: {alert.title} —{' '}
                  {describeAlertDetails(alert)}
                </span>
                <span className="flex gap-2">
                  {alert.status === 'open' && (
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setStatus(alert.id, 'acknowledged')}
                    >
                      確認済みにする
                    </button>
                  )}
                  {alert.status !== 'resolved' ? (
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setStatus(alert.id, 'resolved')}
                    >
                      解決済みにする
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setStatus(alert.id, 'open')}
                    >
                      再オープン
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
