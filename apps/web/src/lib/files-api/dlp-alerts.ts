import { apiFetch } from './core';

/** Phase 4 Task 7: DLP rules & security alerts admin API client + pure helpers. */

export type DlpPatternType =
  | 'builtin_credit_card'
  | 'builtin_mynumber'
  | 'builtin_email_bulk'
  | 'custom_regex';
export type DlpAction = 'alert' | 'escalate_confidential';
export type SecurityAlertStatus = 'open' | 'acknowledged' | 'resolved';
export type SecurityAlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DlpRule {
  id: string;
  name: string;
  patternType: DlpPatternType;
  customPattern: string | null;
  action: DlpAction;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityAlert {
  id: string;
  alertType: 'dlp_match' | 'bulk_download_anomaly' | 'failed_share_password_spike';
  severity: SecurityAlertSeverity;
  title: string;
  details: Record<string, unknown>;
  targetType: string | null;
  targetId: string | null;
  actorId: string | null;
  status: SecurityAlertStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface DlpRuleInput {
  name: string;
  patternType: DlpPatternType;
  customPattern?: string;
  action: DlpAction;
  enabled?: boolean;
}

export const DLP_PATTERN_LABELS: Record<DlpPatternType, string> = {
  builtin_credit_card: 'クレジットカード番号 (Luhn)',
  builtin_mynumber: 'マイナンバー (チェックデジット)',
  builtin_email_bulk: 'メールアドレス大量記載 (5件以上)',
  custom_regex: 'カスタム正規表現',
};

export const DLP_ACTION_LABELS: Record<DlpAction, string> = {
  alert: 'アラートのみ',
  escalate_confidential: '機密へ自動昇格',
};

export const SECURITY_ALERT_TYPE_LABELS: Record<SecurityAlert['alertType'], string> = {
  dlp_match: 'DLP 検知',
  bulk_download_anomaly: '大量ダウンロード',
  failed_share_password_spike: '共有パスワード失敗急増',
};

export const DLP_CUSTOM_PATTERN_MAX_LENGTH = 120;

/** Client-side mirror of the server ReDoS guard; the server remains authoritative. */
export function validateCustomPatternClient(pattern: string): string | null {
  if (!pattern.trim()) return '正規表現を入力してください';
  if (pattern.length > DLP_CUSTOM_PATTERN_MAX_LENGTH) {
    return `${DLP_CUSTOM_PATTERN_MAX_LENGTH}文字以内で入力してください`;
  }
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)) {
    return '入れ子の量指定子 (例: (a+)+) は使用できません';
  }
  try {
    new RegExp(pattern);
  } catch {
    return '正規表現が不正です';
  }
  return null;
}

export function validateDlpRuleInput(input: DlpRuleInput): string | null {
  if (!input.name.trim()) return 'ルール名を入力してください';
  if (input.name.trim().length > 80) return 'ルール名は80文字以内です';
  if (input.patternType === 'custom_regex') {
    return validateCustomPatternClient(input.customPattern ?? '');
  }
  return null;
}

export function filterAlertsByStatus(
  alerts: SecurityAlert[],
  filter: SecurityAlertStatus | 'all'
): SecurityAlert[] {
  return filter === 'all' ? alerts : alerts.filter((a) => a.status === filter);
}

export function describeAlertDetails(alert: SecurityAlert): string {
  const d = alert.details;
  if (alert.alertType === 'dlp_match') {
    return `ルール「${String(d.ruleName ?? '')}」に ${Number(d.matchCount ?? 0)} 件一致`;
  }
  if (alert.alertType === 'bulk_download_anomaly') {
    return `${Number(d.windowMinutes ?? 10)}分間に ${Number(d.downloadCount ?? 0)} 件のダウンロード`;
  }
  return '詳細なし';
}

export function severityTone(severity: SecurityAlertSeverity): string {
  switch (severity) {
    case 'critical':
      return 'border-red-300 bg-red-50 text-red-800';
    case 'high':
      return 'border-orange-300 bg-orange-50 text-orange-800';
    case 'medium':
      return 'border-amber-200 bg-amber-50 text-amber-800';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700';
  }
}

export function fetchDlpRules(): Promise<{ rules: DlpRule[] }> {
  return apiFetch('/api/admin/dlp-rules');
}

export function createDlpRule(input: DlpRuleInput): Promise<{ rule: DlpRule }> {
  return apiFetch('/api/admin/dlp-rules', { method: 'POST', body: JSON.stringify(input) });
}

export function updateDlpRule(
  id: string,
  patch: Partial<Pick<DlpRuleInput, 'name' | 'customPattern' | 'action' | 'enabled'>>
): Promise<{ rule: DlpRule }> {
  return apiFetch(`/api/admin/dlp-rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteDlpRule(id: string): Promise<{ ok: true }> {
  return apiFetch(`/api/admin/dlp-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function testDlpRule(input: {
  patternType: DlpPatternType;
  customPattern?: string;
  sampleText: string;
}): Promise<{ matched: boolean; matchCount: number }> {
  return apiFetch('/api/admin/dlp-rules/test', { method: 'POST', body: JSON.stringify(input) });
}

export function fetchSecurityAlerts(
  status: 'open' | 'all' = 'open'
): Promise<{ alerts: SecurityAlert[] }> {
  return apiFetch(`/api/admin/security-alerts?status=${status}`);
}

export function updateSecurityAlertStatus(
  id: string,
  status: SecurityAlertStatus
): Promise<{ alert: SecurityAlert }> {
  return apiFetch(`/api/admin/security-alerts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}
