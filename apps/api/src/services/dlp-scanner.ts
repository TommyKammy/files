import { buildAuditLogStmt } from './audit';
import { buildClassificationChangeStatements } from './classification-updater';

/**
 * Phase 4 Task 7: ReDoS-safe PII detectors + tenant DLP rule evaluation.
 * NEVER persist or log raw matched values — only rule names and counts.
 */

export type DlpPatternType =
  | 'builtin_credit_card'
  | 'builtin_mynumber'
  | 'builtin_email_bulk'
  | 'custom_regex';
export type DlpAction = 'alert' | 'escalate_confidential';

export const DLP_PATTERN_TYPES: readonly DlpPatternType[] = [
  'builtin_credit_card',
  'builtin_mynumber',
  'builtin_email_bulk',
  'custom_regex',
];
export const DLP_ACTIONS: readonly DlpAction[] = ['alert', 'escalate_confidential'];

export const DLP_MAX_SCAN_CHARS = 16 * 1024;
export const DLP_CUSTOM_PATTERN_MAX_LENGTH = 120;
export const DLP_EMAIL_BULK_THRESHOLD = 5;
export const DOWNLOAD_ANOMALY_THRESHOLD = 30;
const DOWNLOAD_WINDOW_MS = 10 * 60 * 1000;
const ANOMALY_DEDUPE_MS = 60 * 60 * 1000;

export interface DlpScanResult {
  matched: boolean;
  matchCount: number;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Japanese Individual Number (My Number) Mod-11 check digit validation. */
export function myNumberValid(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  const check = digits.charCodeAt(11) - 48;
  let sum = 0;
  // p_n: n = 1 is the rightmost of the first 11 digits.
  for (let n = 1; n <= 11; n += 1) {
    const p = digits.charCodeAt(11 - n) - 48;
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const rem = sum % 11;
  const expected = rem <= 1 ? 0 : 11 - rem;
  return check === expected;
}

function scanCreditCards(text: string): number {
  let count = 0;
  for (const m of text.matchAll(/(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g)) {
    if (luhnValid(m[0].replace(/[ -]/g, ''))) count += 1;
  }
  return count;
}

function scanMyNumbers(text: string): number {
  let count = 0;
  for (const m of text.matchAll(
    /(?<!\d[ -]?)\d{4}[ -]?\d{4}[ -]?\d{4}(?![ -]?\d)/g
  )) {
    if (myNumberValid(m[0].replace(/[ -]/g, ''))) count += 1;
  }
  return count;
}

function scanDistinctEmails(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g)) {
    seen.add(m[0].toLowerCase());
  }
  return seen.size;
}

/** Returns an error message when the custom pattern is unsafe/invalid, else null. */
export function validateCustomPattern(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return 'customPattern is required for custom_regex';
  }
  if (pattern.length > DLP_CUSTOM_PATTERN_MAX_LENGTH) {
    return `customPattern must be ${DLP_CUSTOM_PATTERN_MAX_LENGTH} characters or fewer`;
  }
  // Quantified group that itself contains a quantifier: (a+)+, (.*)*, (a{2,})+ ...
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)) {
    return 'customPattern contains nested quantifiers (ReDoS risk)';
  }
  // Quantified alternation groups, e.g. (a|aa)+
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)) {
    return 'customPattern contains a quantified alternation (ReDoS risk)';
  }
  // Backreferences and lookarounds enable super-linear matching.
  if (/\\[1-9]|\(\?<?[=!]/.test(pattern)) {
    return 'customPattern must not use backreferences or lookarounds';
  }
  try {
    new RegExp(pattern, 'g');
  } catch {
    return 'customPattern is not a valid regular expression';
  }
  return null;
}

function scanCustom(pattern: string, text: string): number {
  if (validateCustomPattern(pattern) !== null) return 0;
  const re = new RegExp(pattern, 'g');
  let count = 0;
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) {
      continue;
    }
    count += 1;
    if (count >= 1000) break;
  }
  return count;
}

export function scanText(
  patternType: DlpPatternType,
  customPattern: string | null | undefined,
  rawText: string
): DlpScanResult {
  const text = rawText.slice(0, DLP_MAX_SCAN_CHARS);
  let count = 0;
  switch (patternType) {
    case 'builtin_credit_card':
      count = scanCreditCards(text);
      break;
    case 'builtin_mynumber':
      count = scanMyNumbers(text);
      break;
    case 'builtin_email_bulk': {
      const distinct = scanDistinctEmails(text);
      count = distinct >= DLP_EMAIL_BULK_THRESHOLD ? distinct : 0;
      break;
    }
    case 'custom_regex':
      count = scanCustom(customPattern ?? '', text);
      break;
  }
  return { matched: count > 0, matchCount: count };
}

interface DlpRuleRow {
  id: string;
  name: string;
  pattern_type: DlpPatternType;
  custom_pattern: string | null;
  action: DlpAction;
}

export async function evaluateDlpRulesForFile(
  db: D1Database,
  tenantId: string,
  input: {
    fileId: string;
    fileName: string;
    excerpt: string | null | undefined;
    actorId: string | null;
  }
): Promise<{ matchedRuleIds: string[]; escalated: boolean }> {
  const result = { matchedRuleIds: [] as string[], escalated: false };
  const rules = await db
    .prepare(
      `SELECT id, name, pattern_type, custom_pattern, action
         FROM dlp_rules WHERE tenant_id = ? AND enabled = 1`
    )
    .bind(tenantId)
    .all<DlpRuleRow>();
  if (rules.results.length === 0) return result;

  const text = `${input.fileName}\n${input.excerpt ?? ''}`;
  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let escalate = false;

  for (const rule of rules.results) {
    const scan = scanText(rule.pattern_type, rule.custom_pattern, text);
    if (!scan.matched) continue;
    result.matchedRuleIds.push(rule.id);
    if (rule.action === 'escalate_confidential') escalate = true;
    stmts.push(
      db
        .prepare(
          `INSERT INTO security_alerts
             (id, tenant_id, alert_type, severity, title, details_json, target_type, target_id, actor_id)
           VALUES (?, ?, 'dlp_match', ?, ?, ?, 'file', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          tenantId,
          rule.action === 'escalate_confidential' ? 'high' : 'medium',
          `DLP rule matched: ${rule.name}`.slice(0, 200),
          JSON.stringify({
            ruleId: rule.id,
            ruleName: rule.name,
            patternType: rule.pattern_type,
            action: rule.action,
            matchCount: scan.matchCount,
          }),
          input.fileId,
          input.actorId
        ),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: input.actorId,
        actorEmail: 'dlp-scanner@system',
        actorIp: 'queue-worker',
        action: 'dlp.rule_matched',
        targetType: 'file',
        targetId: input.fileId,
        metadata: {
          ruleId: rule.id,
          ruleName: rule.name,
          patternType: rule.pattern_type,
          matchCount: scan.matchCount,
          action: rule.action,
        },
        nowIso,
      })
    );
  }

  if (stmts.length === 0) return result;

  if (escalate) {
    const file = await db
      .prepare(
        `SELECT folder_id, size_bytes, classification FROM files
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
      )
      .bind(tenantId, input.fileId)
      .first<{ folder_id: string | null; size_bytes: number; classification: string }>();
    if (file && file.classification !== 'confidential') {
      stmts.push(
        ...buildClassificationChangeStatements(db, {
          tenantId,
          fileId: input.fileId,
          folderId: file.folder_id,
          fromClassification: file.classification as never,
          toClassification: 'confidential',
          sizeBytes: file.size_bytes,
          clearSuggestion: true,
          actorId: null,
          actorEmail: 'dlp-scanner@system',
          actorIp: 'queue-worker',
          auditAction: 'dlp.classification_escalated',
          auditMetadata: { reason: 'DLP rule escalate_confidential' },
          nowIso,
        })
      );
      result.escalated = true;
    }
  }

  await db.batch(stmts);
  return result;
}

export async function detectDownloadAnomaly(
  db: D1Database,
  tenantId: string,
  actorId: string
): Promise<{ alerted: boolean; downloadCount: number }> {
  const since = new Date(Date.now() - DOWNLOAD_WINDOW_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM audit_logs
        WHERE tenant_id = ? AND actor_id = ? AND created_at >= ?
          AND action IN ('file.download', 'shared_link.download', 'workspace.download_zip')
          AND status = 'allowed'`
    )
    .bind(tenantId, actorId, since)
    .first<{ cnt: number }>();
  const downloadCount = row?.cnt ?? 0;
  if (downloadCount < DOWNLOAD_ANOMALY_THRESHOLD) return { alerted: false, downloadCount };

  const dedupeSince = new Date(Date.now() - ANOMALY_DEDUPE_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const existing = await db
    .prepare(
      `SELECT 1 AS x FROM security_alerts
        WHERE tenant_id = ? AND alert_type = 'bulk_download_anomaly'
          AND actor_id = ? AND status = 'open' AND created_at >= ?
        LIMIT 1`
    )
    .bind(tenantId, actorId, dedupeSince)
    .first();
  if (existing) return { alerted: false, downloadCount };

  await db
    .prepare(
      `INSERT INTO security_alerts
         (id, tenant_id, alert_type, severity, title, details_json, target_type, target_id, actor_id)
       VALUES (?, ?, 'bulk_download_anomaly', 'high', ?, ?, 'user', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      tenantId,
      'Bulk download anomaly detected',
      JSON.stringify({
        downloadCount,
        windowMinutes: DOWNLOAD_WINDOW_MS / 60000,
        threshold: DOWNLOAD_ANOMALY_THRESHOLD,
      }),
      actorId,
      actorId
    )
    .run();
  return { alerted: true, downloadCount };
}
