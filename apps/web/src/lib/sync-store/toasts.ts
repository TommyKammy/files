import type { WorkspaceToastItem } from '@/types/files';

const MAX_UNDO_STACK = 20;

export interface UndoAction {
  id: string;
  label: string;
  applyUndo: () => Promise<void> | void;
  redoLabel?: string;
  applyRedo?: () => Promise<void> | void;
}

export interface ToastContext {
  toasts: WorkspaceToastItem[];
  undoStack: UndoAction[];
  redoStack: UndoAction[];
  toastTimers: Map<string, ReturnType<typeof setTimeout>>;
  jobPollTimers: Set<ReturnType<typeof setTimeout>>;
  copiedRootsByMutationId: Map<string, unknown>;
  cancelledCopyMutationIds: Set<string>;
  pendingMutationCount: number;
  emit: () => void;
}

function makeClientMutationId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function clearToastsAndUndo(ctx: ToastContext): void {
  for (const timer of ctx.toastTimers.values()) {
    clearTimeout(timer);
  }
  ctx.toastTimers.clear();
  for (const timer of ctx.jobPollTimers) {
    clearTimeout(timer);
  }
  ctx.jobPollTimers.clear();
  ctx.toasts = [];
  ctx.undoStack = [];
  ctx.redoStack = [];
  ctx.copiedRootsByMutationId.clear();
  ctx.cancelledCopyMutationIds.clear();
  ctx.pendingMutationCount = 0;
}

export function dismissToast(ctx: ToastContext, id: string): void {
  const timer = ctx.toastTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    ctx.toastTimers.delete(id);
  }
  if (ctx.toasts.some((t) => t.id === id)) {
    ctx.toasts = ctx.toasts.filter((t) => t.id !== id);
    ctx.emit();
  }
}

export function pushToast(
  ctx: ToastContext,
  toast: Omit<WorkspaceToastItem, 'id'>,
  ttlMs = 6000
): string {
  const id = makeClientMutationId('toast');
  const next: WorkspaceToastItem = { id, ...toast };
  ctx.toasts = [...ctx.toasts.slice(-2), next];
  ctx.emit();

  if (ttlMs > 0) {
    const timer = setTimeout(() => {
      ctx.toastTimers.delete(id);
      dismissToast(ctx, id);
    }, ttlMs);
    ctx.toastTimers.set(id, timer);
  }
  return id;
}

export async function undoLatest(ctx: ToastContext): Promise<boolean> {
  const entry = ctx.undoStack.pop();
  if (!entry) return false;
  for (const t of ctx.toasts) {
    if (t.canUndo) {
      dismissToast(ctx, t.id);
    }
  }
  await entry.applyUndo();
  if (entry.applyRedo) {
    ctx.redoStack = [...ctx.redoStack.slice(-(MAX_UNDO_STACK - 1)), entry];
  }
  ctx.emit();
  return true;
}

export async function redoLatest(ctx: ToastContext): Promise<boolean> {
  const entry = ctx.redoStack.pop();
  if (!entry || !entry.applyRedo) return false;
  await entry.applyRedo();
  ctx.undoStack = [...ctx.undoStack.slice(-(MAX_UNDO_STACK - 1)), entry];
  ctx.emit();
  return true;
}

export function pushUndo(
  ctx: ToastContext,
  entry: Omit<UndoAction, 'id'>,
  toastMessage: string
): void {
  const action: UndoAction = {
    id: makeClientMutationId('undo'),
    ...entry,
  };
  ctx.redoStack = [];
  ctx.undoStack = [...ctx.undoStack.slice(-(MAX_UNDO_STACK - 1)), action];
  pushToast(ctx, {
    kind: 'undo',
    message: toastMessage,
    undoLabel: '元に戻す',
    canUndo: true,
  });
}
