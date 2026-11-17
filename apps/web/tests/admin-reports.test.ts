import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_REPORT_API_PREFIXES,
  ADMIN_REPORT_CADENCE_LABELS,
  ADMIN_REPORT_STATUS_LABELS,
  ADMIN_REPORT_TYPE_LABELS,
  buildAuditLogCsvHref,
  buildAuditLogQueryString,
  describeAdminReportFilters,
  formatAdminReportBytes,
  formatAdminReportCadence,
  formatAdminReportStatus,
  formatAdminReportType,
  validateAdminReportJobInput,
  validateAdminReportScheduleInput,
} from '@/lib/admin-reports';
import {
  getAdminConsoleNavItem,
  getAdminSectionFetchPlan,
} from '@/lib/admin-console-nav';
import {
  ADMIN_REPORT_AUDIT_ACTION_PREFIXES,
  AUDIT_ACTION_LABELS,
  formatAuditActionLabel,
  isAdminReportAuditAction,
} from '@/lib/admin-audit';

test('audit filter query and CSV link share from/to/actorEmail/targetId', () => {
  const query = buildAuditLogQueryString({
    action: 'shared_link.create',
    actionPrefixes: ['permission.', 'admin.report.'],
    targetType: 'file',
    status: 'blocked',
    actorEmail: 'sys@example.com',
    targetId: 'file-1',
    from: '2026-11-01',
    to: '2026-11-17',
    limit: 50,
  });
  const params = new URLSearchParams(query);
  assert.equal(params.get('action'), 'shared_link.create');
  assert.equal(params.get('actionPrefixes'), 'permission.,admin.report.');
  assert.equal(params.get('targetType'), 'file');
  assert.equal(params.get('status'), 'blocked');
  assert.equal(params.get('actorEmail'), 'sys@example.com');
  assert.equal(params.get('targetId'), 'file-1');
  assert.equal(params.get('from'), '2026-11-01');
  assert.equal(params.get('to'), '2026-11-17');
  assert.equal(params.get('limit'), '50');

  const csvHref = buildAuditLogCsvHref({
    action: 'shared_link.create',
    actorEmail: 'sys@example.com',
    targetId: 'file-1',
    from: '2026-11-01',
    to: '2026-11-17',
  });
  assert.ok(csvHref.startsWith('/api/audit-logs?'));
  const csvParams = new URLSearchParams(csvHref.split('?')[1]);
  assert.equal(csvParams.get('format'), 'csv');
  assert.equal(csvParams.get('limit'), '200');
  assert.equal(csvParams.get('actorEmail'), 'sys@example.com');
  assert.equal(csvParams.get('targetId'), 'file-1');
  assert.equal(csvParams.get('from'), '2026-11-01');
  assert.equal(csvParams.get('to'), '2026-11-17');

  assert.equal(buildAuditLogQueryString(), '');
  assert.equal(
    buildAuditLogCsvHref(),
    '/api/audit-logs?limit=200&format=csv'
  );
});

test('report type, status, cadence and byte formatting are stable', () => {
  assert.deepEqual(Object.keys(ADMIN_REPORT_TYPE_LABELS).sort(), [
    'access_stats',
    'shared_links_inventory',
    'user_activity',
    'users_and_guests',
  ]);
  assert.equal(
    formatAdminReportType('user_activity'),
    'ユーザーアクティビティ'
  );
  assert.equal(formatAdminReportStatus('queued'), '待機中');
  assert.equal(formatAdminReportStatus('running'), '生成中');
  assert.equal(formatAdminReportStatus('completed'), '完了');
  assert.equal(formatAdminReportStatus('failed'), '失敗');
  assert.equal(formatAdminReportCadence('weekly'), '毎週');
  assert.equal(formatAdminReportCadence('monthly'), '毎月');
  assert.equal(ADMIN_REPORT_STATUS_LABELS.failed, '失敗');
  assert.equal(ADMIN_REPORT_CADENCE_LABELS.weekly, '毎週');

  assert.equal(formatAdminReportBytes(0), '0 B');
  assert.equal(formatAdminReportBytes(1023), '1023 B');
  assert.equal(formatAdminReportBytes(2048), '2.0 KB');
  assert.equal(formatAdminReportBytes(5 * 1024 * 1024), '5.0 MB');

  assert.equal(
    describeAdminReportFilters({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-17T23:59:59.999Z',
      actorEmail: 'sys@example.com',
      targetId: 'file-1',
      status: 'blocked',
      actionPrefix: 'file.',
    }),
    '2026-11-01 〜 2026-11-17 / actor: sys@example.com / target: file-1 / blocked / prefix: file.'
  );
  assert.equal(describeAdminReportFilters({}), '全期間・全対象');
});

test('report job and schedule validation reject invalid ranges and cadence', () => {
  const validJob = validateAdminReportJobInput({
    reportType: 'user_activity',
    from: '2026-11-01',
    to: '2026-11-17',
    actorEmail: 'sys@example.com',
    targetId: 'file-1',
    actionPrefix: 'file.',
    status: 'blocked',
  });
  assert.equal(validJob.ok, true);
  if (validJob.ok) {
    assert.equal(validJob.value.reportType, 'user_activity');
    assert.deepEqual(validJob.value.filters, {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-17T23:59:59.999Z',
      actorEmail: 'sys@example.com',
      targetId: 'file-1',
      actionPrefix: 'file.',
      status: 'blocked',
    });
  }

  const reversed = validateAdminReportJobInput({
    reportType: 'user_activity',
    from: '2026-11-18',
    to: '2026-11-17',
  });
  assert.equal(reversed.ok, false);

  const invalidType = validateAdminReportJobInput({
    reportType: 'unknown',
  });
  assert.equal(invalidType.ok, false);

  const validSchedule = validateAdminReportScheduleInput({
    name: '  週次レポート  ',
    reportType: 'users_and_guests',
    cadence: 'weekly',
    retentionDays: '30',
    from: '2026-11-01',
    to: '2026-11-17',
    status: 'allowed',
  });
  assert.equal(validSchedule.ok, true);
  if (validSchedule.ok) {
    assert.equal(validSchedule.value.name, '週次レポート');
    assert.equal(validSchedule.value.retentionDays, 30);
    assert.deepEqual(validSchedule.value.filters, {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-17T23:59:59.999Z',
      status: 'allowed',
    });
  }

  assert.equal(
    validateAdminReportScheduleInput({
      name: '',
      reportType: 'users_and_guests',
      cadence: 'weekly',
      retentionDays: '30',
    }).ok,
    false
  );
  assert.equal(
    validateAdminReportScheduleInput({
      name: 'Daily',
      reportType: 'users_and_guests',
      cadence: 'daily',
      retentionDays: '30',
    }).ok,
    false
  );
  assert.equal(
    validateAdminReportScheduleInput({
      name: 'Too long',
      reportType: 'users_and_guests',
      cadence: 'monthly',
      retentionDays: '0',
    }).ok,
    false
  );
  assert.equal(
    validateAdminReportScheduleInput({
      name: 'Too long',
      reportType: 'users_and_guests',
      cadence: 'monthly',
      retentionDays: '366',
    }).ok,
    false
  );
});

test('/admin/reports owns only audit + report APIs (nav isolation)', () => {
  assert.deepEqual(getAdminSectionFetchPlan('reports'), {
    insights: false,
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: true,
    inheritanceConflicts: false,
    settingsBundle: false,
    completesImmediately: false,
  });
  assert.equal(getAdminConsoleNavItem('reports').href, '/admin/reports');
  assert.ok(
    ADMIN_REPORT_API_PREFIXES.every((prefix) =>
      prefix.startsWith('/api/admin/reports')
    )
  );

  const plan = getAdminSectionFetchPlan('reports');
  for (const key of [
    'insights',
    'storageStats',
    'aiSuggestions',
    'sharedLinks',
    'policies',
    'inheritanceConflicts',
    'settingsBundle',
  ] as const) {
    assert.equal(plan[key], false, `${key} must not load on /admin/reports`);
  }
  assert.equal(plan.auditLogs, true);
});

test('admin.report.* audit actions have labels and a report prefix', () => {
  assert.deepEqual([...ADMIN_REPORT_AUDIT_ACTION_PREFIXES], ['admin.report.']);
  for (const action of [
    'admin.report.requested',
    'admin.report.generated',
    'admin.report.downloaded',
  ]) {
    assert.equal(isAdminReportAuditAction(action), true);
    assert.ok(AUDIT_ACTION_LABELS[action]);
    assert.notEqual(formatAuditActionLabel(action), action);
  }
  assert.equal(
    formatAuditActionLabel('admin.report.generated'),
    '非同期レポート生成完了'
  );
  assert.equal(isAdminReportAuditAction('admin.session.revoke'), false);
});
