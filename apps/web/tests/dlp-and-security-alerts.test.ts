import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeAlertDetails,
  filterAlertsByStatus,
  validateCustomPatternClient,
  validateDlpRuleInput,
  type SecurityAlert,
} from '@/lib/files-api/dlp-alerts';

function alert(overrides: Partial<SecurityAlert> = {}): SecurityAlert {
  return {
    id: 'a1',
    alertType: 'dlp_match',
    severity: 'medium',
    title: 't',
    details: { ruleName: 'Cards', matchCount: 2 },
    targetType: 'file',
    targetId: 'f1',
    actorId: null,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    createdAt: '2026-11-21 00:00:00',
    ...overrides,
  };
}

test('custom pattern validation rejects nested quantifiers and long patterns', () => {
  assert.notEqual(validateCustomPatternClient('(a+)+'), null);
  assert.notEqual(validateCustomPatternClient('(.*)*'), null);
  assert.notEqual(validateCustomPatternClient('a'.repeat(121)), null);
  assert.notEqual(validateCustomPatternClient('['), null);
  assert.equal(validateCustomPatternClient('PROJ-\\d{4}'), null);
});

test('rule input validation', () => {
  assert.notEqual(validateDlpRuleInput({ name: ' ', patternType: 'builtin_credit_card', action: 'alert' }), null);
  assert.equal(validateDlpRuleInput({ name: 'ok', patternType: 'builtin_mynumber', action: 'alert' }), null);
  assert.notEqual(
    validateDlpRuleInput({ name: 'ok', patternType: 'custom_regex', action: 'alert' }),
    null
  );
});

test('alert filtering and detail descriptions never expose raw values', () => {
  const list = [alert(), alert({ id: 'a2', status: 'resolved' })];
  assert.equal(filterAlertsByStatus(list, 'open').length, 1);
  assert.equal(filterAlertsByStatus(list, 'all').length, 2);
  assert.match(describeAlertDetails(alert()), /Cards.*2/);
  assert.match(
    describeAlertDetails(
      alert({ alertType: 'bulk_download_anomaly', details: { downloadCount: 31, windowMinutes: 10 } })
    ),
    /31/
  );
});
