import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAuditDateTime, formatDateTime } from '@/lib/formatters';

test('audit timestamps are rendered in JST with an explicit zone label', () => {
  assert.equal(
    formatAuditDateTime('2026-11-15T13:57:10.281Z'),
    '2026/11/15 22:57 JST'
  );
});

test('formatDateTime keeps the existing local-time behavior and invalid-input fallback', () => {
  assert.match(
    formatDateTime('2026-11-15T13:57:10.281Z'),
    /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/
  );
  assert.equal(formatDateTime(null), '—');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
});
