import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRANDING_ACCENT_COLOR_PRESETS,
  normalizeHexAccentColor,
  readBranding,
} from '@/lib/admin-compliance';
import {
  countVisibleWorkspaceColumns,
  DEFAULT_WORKSPACE_COLUMN_VISIBILITY,
  loadWorkspaceColumnVisibility,
  saveWorkspaceColumnVisibility,
  WORKSPACE_OPTIONAL_COLUMNS,
  WORKSPACE_TABLE_COLUMNS_STORAGE_KEY,
} from '@/lib/workspace-table-columns';
import type { TenantPolicyRow } from '@/types/files';

function makePolicy(overrides: Partial<TenantPolicyRow> = {}): TenantPolicyRow {
  return {
    tenant_id: 't1',
    enforce_company_only_links: 0,
    require_watermark_confidential: 1,
    max_link_expiration_days: 30,
    session_max_hours: 12,
    trash_retention_days: 30,
    ai_classification_mode: 'metadata_only',
    ai_auto_apply_threshold: null,
    updated_by: null,
    updated_at: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

test('normalizeHexAccentColor validates strict #RRGGBB and normalizes case', () => {
  assert.equal(normalizeHexAccentColor('#2563EB'), '#2563eb');
  assert.equal(normalizeHexAccentColor(' #0f766e '), '#0f766e');
  assert.equal(normalizeHexAccentColor(''), null);
  assert.equal(normalizeHexAccentColor(null), null);
  assert.equal(normalizeHexAccentColor('#fff'), null);
  assert.equal(normalizeHexAccentColor('red'), null);
  assert.equal(normalizeHexAccentColor('#12345g'), null);
  assert.ok(BRANDING_ACCENT_COLOR_PRESETS.length >= 5);
});

test('readBranding extracts logoUrl and validated accentColor from policy row', () => {
  const branding = readBranding(
    makePolicy({
      brandingOrgName: 'Acme Corp',
      brandingLogoUrl: '/api/branding/t1/logo',
      brandingAccentColor: '#4F46E5',
    })
  );
  assert.equal(branding.orgName, 'Acme Corp');
  assert.equal(branding.logoUrl, '/api/branding/t1/logo');
  assert.equal(branding.accentColor, '#4f46e5');

  const invalidAccentBranding = readBranding(
    makePolicy({
      branding_accent_color: 'javascript:alert(1)',
    })
  );
  assert.equal(invalidAccentBranding.accentColor, null);
  assert.equal(invalidAccentBranding.logoUrl, null);
});

test('workspace-table-columns safely falls back during SSR and persists to localStorage', () => {
  // SSR fallback (window is undefined in node:test)
  const ssrDefaults = loadWorkspaceColumnVisibility();
  assert.deepEqual(ssrDefaults, DEFAULT_WORKSPACE_COLUMN_VISIBILITY);
  assert.equal(countVisibleWorkspaceColumns(ssrDefaults), 6);
  assert.equal(WORKSPACE_OPTIONAL_COLUMNS.length, 4);

  // Mock window.localStorage
  const store = new Map<string, string>();
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  };
  try {
    const custom = {
      classification: false,
      extension: true,
      size: true,
      updated_at: false,
    };
    saveWorkspaceColumnVisibility(custom);
    assert.ok(store.has(WORKSPACE_TABLE_COLUMNS_STORAGE_KEY));
    assert.deepEqual(loadWorkspaceColumnVisibility(), custom);
    assert.equal(countVisibleWorkspaceColumns(custom), 5);

    // Corrupted JSON falls back safely
    store.set(WORKSPACE_TABLE_COLUMNS_STORAGE_KEY, '{not-valid-json');
    assert.deepEqual(
      loadWorkspaceColumnVisibility(),
      DEFAULT_WORKSPACE_COLUMN_VISIBILITY
    );
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});
