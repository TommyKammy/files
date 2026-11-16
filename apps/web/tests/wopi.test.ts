import assert from 'node:assert/strict';
import test from 'node:test';
import { getFileExtension, isWopiEditableFile } from '../src/lib/wopi';

test('detects Office and OpenDocument extensions for WOPI editor routing', () => {
  assert.equal(isWopiEditableFile({ name: 'report.docx', extension: 'docx' }), true);
  assert.equal(isWopiEditableFile({ name: 'budget.xlsx', extension: null }), true);
  assert.equal(isWopiEditableFile({ name: 'deck.pptx', extension: 'PPTX' }), true);
  assert.equal(isWopiEditableFile({ name: 'notes.odt', extension: 'odt' }), true);
  assert.equal(isWopiEditableFile({ name: 'manual.pdf', extension: 'pdf' }), false);
  assert.equal(isWopiEditableFile({ name: 'image.png', extension: 'png' }), false);
});

test('falls back to the file name when the extension field is missing', () => {
  assert.equal(getFileExtension({ name: 'Quarterly.Report.XLSX', extension: null }), 'xlsx');
  assert.equal(getFileExtension({ name: 'no-extension', extension: null }), '');
});
