import type {
  ClassificationLabel,
  FolderSummary,
  SearchResultItem,
} from '@/types/files';

export type KeyboardScope =
  | 'workspace'
  | 'inlineRename'
  | 'contextMenu'
  | 'moveCopyModal'
  | 'picker'
  | 'preview'
  | 'modal'
  | 'help'
  | 'palette';

export interface KeyboardScopeEntry {
  token: string;
  scope: KeyboardScope;
}


export class KeyboardScopeStack {
  private entries: KeyboardScopeEntry[] = [];
  private seq = 0;

  pushScope(scope: KeyboardScope, customToken?: string): string {
    const token = customToken ?? `${scope}:${++this.seq}`;
    this.entries = this.entries.filter((entry) => entry.token !== token);
    this.entries.push({ token, scope });
    return token;
  }

  popScope(token: string): void {
    this.entries = this.entries.filter((entry) => entry.token !== token);
  }

  getTopScope(): KeyboardScope {
    const top = this.entries[this.entries.length - 1];
    return top ? top.scope : 'workspace';
  }

  isTopToken(token: string): boolean {
    const top = this.entries[this.entries.length - 1];
    return top?.token === token;
  }

  getDepth(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

export const keyboardScopes = new KeyboardScopeStack();

/** Detects active Japanese/CJK IME composition frames (including Safari keyCode 229 / 'Process'). */

