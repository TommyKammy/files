import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleAdminTabs } from '@/lib/admin-console-tabs';
import {
  createEmptyFieldDraft,
  createEmptyTemplateDraft,
  parseEnumOptionsText,
  templateToDraft,
  validateMetadataTemplateDraft,
} from '@/lib/admin-metadata-templates';
import {
  COLLECTION_COLOR_OPTIONS,
  getCollectionDotClass,
  validateCollectionName,
} from '@/lib/files-api/collections';
import type { MetadataTemplate } from '@/lib/files-api/tags-metadata';

test('validateMetadataTemplateDraft validates template keys, fields, and enum options', () => {
  const empty = createEmptyTemplateDraft();
  assert.equal(
    validateMetadataTemplateDraft(empty, { requireKey: true }).valid,
    false
  );

  const invalidKey = validateMetadataTemplateDraft(
    {
      key: 'Invalid Key!',
      displayName: '契約情報',
      description: '',
      fields: [{ ...createEmptyFieldDraft(), key: 'num', label: '番号' }],
    },
    { requireKey: true }
  );
  assert.equal(invalidKey.valid, false);

  const duplicateFieldKey = validateMetadataTemplateDraft(
    {
      key: 'contract_info',
      displayName: '契約情報',
      description: '  説明文  ',
      fields: [
        { key: 'code', label: 'コード', type: 'text', required: true, optionsText: '' },
        { key: 'CODE', label: 'コード2', type: 'number', required: false, optionsText: '' },
      ],
    },
    { requireKey: true }
  );
  assert.equal(duplicateFieldKey.valid, false);

  const missingEnumOptions = validateMetadataTemplateDraft(
    {
      key: 'contract_info',
      displayName: '契約情報',
      description: '',
      fields: [
        { key: 'status', label: 'ステータス', type: 'enum', required: true, optionsText: ' , ' },
      ],
    },
    { requireKey: true }
  );
  assert.equal(missingEnumOptions.valid, false);

  const valid = validateMetadataTemplateDraft(
    {
      key: '  Contract_Info  ',
      displayName: '  契約情報  ',
      description: '  契約書用メタデータ  ',
      fields: [
        {
          key: 'contract_no',
          label: '契約番号',
          type: 'text',
          required: true,
          optionsText: '',
        },
        {
          key: 'status',
          label: 'ステータス',
          type: 'enum',
          required: false,
          optionsText: 'ドラフト, レビュー中, 締結済, ドラフト',
        },
      ],
    },
    { requireKey: true }
  );
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.key, 'contract_info');
    assert.equal(valid.displayName, '契約情報');
    assert.equal(valid.description, '契約書用メタデータ');
    assert.deepEqual(valid.fields, [
      { key: 'contract_no', label: '契約番号', type: 'text', required: true },
      {
        key: 'status',
        label: 'ステータス',
        type: 'enum',
        required: false,
        options: ['ドラフト', 'レビュー中', '締結済'],
      },
    ]);
  }
});

test('templateToDraft round-trips MetadataTemplate and parseEnumOptionsText deduplicates', () => {
  assert.deepEqual(parseEnumOptionsText(' a, b , a,  , c '), ['a', 'b', 'c']);

  const tpl: MetadataTemplate = {
    id: 'tpl-1',
    key: 'legal_case',
    displayName: '法務案件',
    description: null,
    fields: [
      {
        key: 'priority',
        label: '優先度',
        type: 'enum',
        required: true,
        options: ['高', '中', '低'],
      },
    ],
    createdBy: 'u1',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };

  const draft = templateToDraft(tpl);
  assert.equal(draft.key, 'legal_case');
  assert.equal(draft.description, '');
  assert.equal(draft.fields[0]?.optionsText, '高, 中, 低');
});

test('metadata-templates tab is visible only to sys_admin and sec_admin', () => {
  const sysTabs = getVisibleAdminTabs(
    { role: 'sys_admin', userType: 'member', adminCapabilities: [] },
    'content'
  ).map((t) => t.id);
  assert.ok(sysTabs.includes('metadata-templates'));

  const secTabs = getVisibleAdminTabs(
    { role: 'sec_admin', userType: 'member', adminCapabilities: [] },
    'content'
  ).map((t) => t.id);
  assert.ok(secTabs.includes('metadata-templates'));

  const coAdminTabs = getVisibleAdminTabs(
    {
      role: 'member',
      userType: 'member',
      adminCapabilities: ['admin.content.unlock', 'admin.trash.manage'],
    },
    'content'
  ).map((t) => t.id);
  assert.ok(!coAdminTabs.includes('metadata-templates'));
});

test('validateCollectionName and color helpers enforce 1..60 char trimmed rules', () => {
  assert.equal(validateCollectionName('   ').valid, false);
  assert.equal(validateCollectionName('a'.repeat(61)).valid, false);

  const ok = validateCollectionName('  重要案件  ');
  assert.deepEqual(ok, { valid: true, name: '重要案件' });

  const exact60 = validateCollectionName('x'.repeat(60));
  assert.equal(exact60.valid, true);

  assert.ok(COLLECTION_COLOR_OPTIONS.some((c) => c.value === 'indigo'));
  assert.equal(getCollectionDotClass('indigo'), 'bg-indigo-500');
  assert.equal(getCollectionDotClass('unknown-color'), 'bg-slate-500');
});
