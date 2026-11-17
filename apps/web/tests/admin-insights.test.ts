import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_INSIGHTS_DRILLDOWN_HREFS,
  ADMIN_INSIGHTS_RANGE_OPTIONS,
  ADMIN_INSIGHTS_TREND_SERIES,
  buildAdminInsightsChartPoints,
  buildAdminInsightsDrilldownHref,
  buildAdminInsightsQueryString,
  buildAdminInsightsTrendTableRows,
  formatAdminInsightsDayLabel,
  getAdminInsightsTrendValues,
  groupAdminInsightsBlockedActions,
  normalizeAdminInsightsTrendValues,
  parseAdminInsightsDays,
  sumAdminInsightsTrendMetric,
} from '@/lib/admin-insights';
import type { AdminInsightsTrendPoint } from '@/types/files';

function trend(
  day: string,
  overrides: Partial<AdminInsightsTrendPoint> = {}
): AdminInsightsTrendPoint {
  return {
    day,
    activeUsers: 0,
    activeGuests: 0,
    newFiles: 0,
    downloads: 0,
    sharedLinksCreated: 0,
    blockedAudits: 0,
    usedBytesSnapshot: 0,
    totalFilesSnapshot: 0,
    ...overrides,
  };
}

test('insights range parsing and API query string stay on 7/30 days', () => {
  assert.deepEqual([...ADMIN_INSIGHTS_RANGE_OPTIONS], [7, 30]);
  assert.equal(parseAdminInsightsDays(undefined), 7);
  assert.equal(parseAdminInsightsDays(null), 7);
  assert.equal(parseAdminInsightsDays(''), 7);
  assert.equal(parseAdminInsightsDays('7'), 7);
  assert.equal(parseAdminInsightsDays('30'), 30);
  assert.equal(parseAdminInsightsDays(['30', '7']), 30);
  // Invalid/unknown query values never widen the aggregation window.
  assert.equal(parseAdminInsightsDays('90'), 7);
  assert.equal(parseAdminInsightsDays('all'), 7);
  assert.equal(buildAdminInsightsQueryString(7), '?days=7');
  assert.equal(buildAdminInsightsQueryString(30), '?days=30');
});

test('blocked audit actions group into stable risk categories', () => {
  const categories = groupAdminInsightsBlockedActions([
    { action: 'auth.ip_blocked', count: 4 },
    { action: 'shared_link.password_failed', count: 3 },
    { action: 'shared_link.password_locked', count: 1 },
    { action: 'auth.sso_domain_blocked', count: 2 },
    { action: 'shared_link.download_blocked', count: 5 },
    { action: 'file.content_access_denied', count: 1 },
    { action: 'some.future_block', count: 2 },
  ]);

  assert.deepEqual(
    categories.map((category) => [category.key, category.count]),
    [
      ['dlp', 6],
      ['password', 4],
      ['domain', 2],
      ['ip', 4],
      ['other', 2],
    ]
  );
  assert.deepEqual(categories[0]?.actions, [
    'file.content_access_denied',
    'shared_link.download_blocked',
  ]);
  assert.equal(
    categories.reduce((total, category) => total + category.count, 0),
    18
  );

  // Empty input still returns the four named categories (with zero counts) so
  // the UI layout does not jump when the first blocked event appears.
  const empty = groupAdminInsightsBlockedActions([]);
  assert.deepEqual(
    empty.map((category) => category.key),
    ['dlp', 'password', 'domain', 'ip', 'other']
  );
  assert.equal(
    empty.reduce((total, category) => total + category.count, 0),
    0
  );
});

test('drill-down URLs target the owning admin section', () => {
  assert.equal(
    buildAdminInsightsDrilldownHref('unsetSharedFiles'),
    '/admin/content'
  );
  assert.equal(
    buildAdminInsightsDrilldownHref('lockedFiles'),
    '/admin/content'
  );
  assert.equal(
    buildAdminInsightsDrilldownHref('blockedAudit'),
    '/admin/reports?auditPreset=security'
  );
  assert.equal(
    buildAdminInsightsDrilldownHref('activeMembers'),
    '/admin/users'
  );
  assert.equal(
    buildAdminInsightsDrilldownHref('activeGuests'),
    '/admin/users'
  );
  assert.equal(
    buildAdminInsightsDrilldownHref('publicSharedLinks'),
    '/admin/settings'
  );
  assert.deepEqual(ADMIN_INSIGHTS_DRILLDOWN_HREFS, {
    unsetSharedFiles: '/admin/content',
    lockedFiles: '/admin/content',
    blockedAudit: '/admin/reports?auditPreset=security',
    activeMembers: '/admin/users',
    activeGuests: '/admin/users',
    publicSharedLinks: '/admin/settings',
  });
});

test('trend normalisation is zero-safe and scales against the series max', () => {
  assert.deepEqual(normalizeAdminInsightsTrendValues([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(normalizeAdminInsightsTrendValues([]), []);
  assert.deepEqual(normalizeAdminInsightsTrendValues([2, 4, 1]), [
    0.5, 1, 0.25,
  ]);
  // Negative values are clamped before scaling.
  assert.deepEqual(normalizeAdminInsightsTrendValues([-5, 10, 5]), [0, 1, 0.5]);

  const points = buildAdminInsightsChartPoints([0, 5, 10], 100, 50, 5);
  assert.equal(points, '5.00,45.00 50.00,25.00 95.00,5.00');
  assert.equal(buildAdminInsightsChartPoints([], 100, 50, 5), '');
  assert.equal(
    buildAdminInsightsChartPoints([1], 100, 50, 5),
    '5.00,5.00'
  );
});

test('trend tables preserve a gap-free daily series and aggregate totals', () => {
  const trends = [
    trend('2026-11-15', {
      activeUsers: 3,
      activeGuests: 1,
      newFiles: 2,
      downloads: 5,
      sharedLinksCreated: 1,
      blockedAudits: 0,
    }),
    trend('2026-11-16', {
      activeUsers: 4,
      activeGuests: 2,
      newFiles: 0,
      downloads: 3,
      sharedLinksCreated: 2,
      blockedAudits: 1,
    }),
    trend('2026-11-17', {
      activeUsers: 6,
      activeGuests: 3,
      newFiles: 1,
      downloads: 0,
      sharedLinksCreated: 0,
      blockedAudits: 2,
    }),
  ];

  assert.deepEqual(
    trends.map((point) => point.day).map(formatAdminInsightsDayLabel),
    ['11/15', '11/16', '11/17']
  );
  assert.equal(formatAdminInsightsDayLabel('not-a-day'), 'not-a-day');

  assert.deepEqual(
    buildAdminInsightsTrendTableRows(trends).map((row) => ({
      day: row.day,
      label: row.label,
      newFiles: row.newFiles,
      downloads: row.downloads,
      blockedAudits: row.blockedAudits,
    })),
    [
      {
        day: '2026-11-15',
        label: '11/15',
        newFiles: 2,
        downloads: 5,
        blockedAudits: 0,
      },
      {
        day: '2026-11-16',
        label: '11/16',
        newFiles: 0,
        downloads: 3,
        blockedAudits: 1,
      },
      {
        day: '2026-11-17',
        label: '11/17',
        newFiles: 1,
        downloads: 0,
        blockedAudits: 2,
      },
    ]
  );

  assert.deepEqual(getAdminInsightsTrendValues(trends, 'downloads'), [5, 3, 0]);
  assert.equal(sumAdminInsightsTrendMetric(trends, 'newFiles'), 3);
  assert.equal(sumAdminInsightsTrendMetric(trends, 'downloads'), 8);
  assert.equal(sumAdminInsightsTrendMetric(trends, 'blockedAudits'), 3);
  assert.deepEqual(
    ADMIN_INSIGHTS_TREND_SERIES.map((series) => series.key),
    ['newFiles', 'downloads', 'blockedAudits']
  );
});
