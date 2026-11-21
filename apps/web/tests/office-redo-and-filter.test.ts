import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOfficeFileName } from '../src/lib/files-api/create-office';
import {
  clearToastsAndUndo,
  pushUndo,
  redoLatest,
  undoLatest,
  type ToastContext,
} from '../src/lib/sync-store/toasts';
import {
  DEFAULT_WORKSPACE_QUICK_FILTER,
  filterWorkspaceItems,
  isWorkspaceFilterActive,
} from '../src/lib/workspace-filter';
import type { FileItem, FolderSummary, WorkspaceToastItem } from '../src/types/files';

function makeToastCtx(): ToastContext {
  return {
    toasts: [] as WorkspaceToastItem[],
    undoStack: [],
    redoStack: [],
    toastTimers: new Map(),
    jobPollTimers: new Set(),
    copiedRootsByMutationId: new Map(),
    cancelledCopyMutationIds: new Set(),
    pendingMutationCount: 0,
    emit: () => {},
  };
}

function makeFolder(
  id: string,
  name: string,
  classification: FolderSummary['classification'] = 'unset'
): FolderSummary {
  return {
    id,
    parent_id: null,
    name,
    version: 1,
    classification,
    is_pinned: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeFile(
  id: string,
  name: string,
  classification: FileItem['classification'] = 'unset'
): FileItem {
  return {
    id,
    folder_id: 'f1',
    name,
    extension: name.split('.').pop() ?? null,
    mime_type: 'application/octet-stream',
    size_bytes: 100,
    upload_state: 'active',
    current_version_num: 1,
    meta_version: 1,
    classification,
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

test('Redo stack: pushes on undo, executes redo, and clears redoStack on new mutation', async () => {
  const ctx = makeToastCtx();
  let value = 'initial';

  pushUndo(
    ctx,
    {
      label: 'change to A',
      applyUndo: () => {
        value = 'initial';
      },
      applyRedo: () => {
        value = 'A';
      },
    },
    'Changed to A'
  );
  value = 'A';

  assert.equal(ctx.undoStack.length, 1);
  assert.equal(ctx.redoStack.length, 0);

  const undone = await undoLatest(ctx);
  assert.equal(undone, true);
  assert.equal(value, 'initial');
  assert.equal(ctx.undoStack.length, 0);
  assert.equal(ctx.redoStack.length, 1);

  const redone = await redoLatest(ctx);
  assert.equal(redone, true);
  assert.equal(value, 'A');
  assert.equal(ctx.undoStack.length, 1);
  assert.equal(ctx.redoStack.length, 0);

  await undoLatest(ctx);
  assert.equal(ctx.redoStack.length, 1);

  pushUndo(
    ctx,
    {
      label: 'change to B',
      applyUndo: () => {
        value = 'initial';
      },
      applyRedo: () => {
        value = 'B';
      },
    },
    'Changed to B'
  );
  assert.equal(ctx.redoStack.length, 0);
  assert.equal(ctx.undoStack.length, 1);

  await undoLatest(ctx);
  assert.equal(ctx.redoStack.length, 1);
  clearToastsAndUndo(ctx);
  assert.equal(ctx.undoStack.length, 0);
  assert.equal(ctx.redoStack.length, 0);
});

test('Redo stack: caps at 20 entries and returns false when empty', async () => {
  const ctx = makeToastCtx();
  assert.equal(await redoLatest(ctx), false);

  for (let i = 0; i < 25; i += 1) {
    pushUndo(
      ctx,
      {
        label: `op-${i}`,
        applyUndo: () => {},
        applyRedo: () => {},
      },
      `op-${i}`
    );
  }
  assert.equal(ctx.undoStack.length, 20);

  while (ctx.undoStack.length > 0) {
    await undoLatest(ctx);
  }
  assert.equal(ctx.redoStack.length, 20);
});

test('In-folder quick filter: filters by query, itemType, and classification', () => {
  const folders = [
    makeFolder('d1', 'Contracts 2026', 'confidential'),
    makeFolder('d2', 'Public Assets', 'public'),
  ];
  const files = [
    makeFile('f1', 'Q4 Report.docx', 'internal'),
    makeFile('f2', 'Budget.xlsx', 'confidential'),
    makeFile('f3', 'Logo.png', 'public'),
  ];

  assert.equal(isWorkspaceFilterActive(DEFAULT_WORKSPACE_QUICK_FILTER), false);
  const all = filterWorkspaceItems({
    folders,
    files,
    filter: DEFAULT_WORKSPACE_QUICK_FILTER,
  });
  assert.equal(all.folders.length, 2);
  assert.equal(all.files.length, 3);

  const byQuery = filterWorkspaceItems({
    folders,
    files,
    filter: { ...DEFAULT_WORKSPACE_QUICK_FILTER, query: 'report' },
  });
  assert.equal(byQuery.folders.length, 0);
  assert.deepEqual(
    byQuery.files.map((f) => f.id),
    ['f1']
  );

  const folderOnly = filterWorkspaceItems({
    folders,
    files,
    filter: { ...DEFAULT_WORKSPACE_QUICK_FILTER, itemType: 'folder' },
  });
  assert.equal(folderOnly.folders.length, 2);
  assert.equal(folderOnly.files.length, 0);

  const fileOnly = filterWorkspaceItems({
    folders,
    files,
    filter: { ...DEFAULT_WORKSPACE_QUICK_FILTER, itemType: 'file' },
  });
  assert.equal(fileOnly.folders.length, 0);
  assert.equal(fileOnly.files.length, 3);

  const byCls = filterWorkspaceItems({
    folders,
    files,
    filter: {
      query: '',
      itemType: 'all',
      classification: 'confidential',
    },
  });
  assert.deepEqual(
    byCls.folders.map((d) => d.id),
    ['d1']
  );
  assert.deepEqual(
    byCls.files.map((f) => f.id),
    ['f2']
  );
});

test('Office filename normalization appends extension when missing and preserves existing extension', () => {
  assert.equal(
    normalizeOfficeFileName('  Meeting Notes  ', 'docx'),
    'Meeting Notes.docx'
  );
  assert.equal(normalizeOfficeFileName('Spec.DOCX', 'docx'), 'Spec.DOCX');
  assert.equal(normalizeOfficeFileName('Budget', 'xlsx'), 'Budget.xlsx');
  assert.equal(normalizeOfficeFileName('Budget.xlsx', 'xlsx'), 'Budget.xlsx');
  assert.equal(normalizeOfficeFileName('Deck', 'pptx'), 'Deck.pptx');
  assert.equal(normalizeOfficeFileName('   ', 'pptx'), '');
});
