import type {
  ClassificationLabel,
  FolderSummary,
  SearchResultItem,
} from '@/types/files';

import { parseSearchQuery } from './search';

export type PaletteCommandId =
  | 'cmd:new-folder'
  | 'cmd:move-copy'
  | 'cmd:copy'
  | 'cmd:cut'
  | 'cmd:paste'
  | 'cmd:duplicate'
  | 'cmd:toggle-inspector'
  | 'cmd:toggle-view'
  | 'cmd:change-classification'
  | 'cmd:share'
  | 'cmd:trash'
  | 'cmd:shortcuts'
  | 'filter:confidential'
  | 'filter:internal'
  | 'filter:unset'
  | 'nav:workspace'
  | 'nav:trash'
  | 'nav:admin'
  | 'action:logout';

export interface PaletteCommand {
  id: PaletteCommandId;
  label: string;
  description: string;
  shortcutHint?: string;
  keywords: string[];
  category: 'action' | 'filter' | 'navigation';
}

export type PaletteEntry =
  | { kind: 'command'; key: string; command: PaletteCommand }
  | {
      kind: 'local-folder';
      key: string;
      folder: FolderSummary;
      pathHint: string;
    }
  | {
      kind: 'file';
      key: string;
      item: SearchResultItem;
      source: 'local' | 'fts5';
    };


export function buildPaletteCommands(options: {
  isAdmin: boolean;
  isWorkspace: boolean;
  hasTargetItem: boolean;
  canClassifyTarget: boolean;
  canShareTarget: boolean;
  canTrashTarget: boolean;
  canCopyTarget?: boolean;
  canCutTarget?: boolean;
  canPasteClipboard?: boolean;
  canDuplicateTarget?: boolean;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  if (options.isWorkspace) {
    if (options.hasTargetItem) {
      commands.push({
        id: 'cmd:move-copy',
        label: '選択項目をフォルダへ移動 / コピー...',
        description: 'ツリーピッカーを開いて移動または Zero-Copy 複製を行います',
        shortcutHint: 'm',
        keywords: ['move', 'copy', 'folder', '移動', 'コピー', 'フォルダ'],
        category: 'action',
      });
    }
    if (options.canPasteClipboard) {
      commands.push({
        id: 'cmd:paste',
        label: 'ここへ貼り付け',
        description: 'クリップボード内のアイテムを現在のフォルダへ貼り付けます',
        shortcutHint: '⌘V',
        keywords: ['paste', 'clipboard', '貼り付け', 'ペースト'],
        category: 'action',
      });
    }
    if (options.canCopyTarget && options.hasTargetItem) {
      commands.push({
        id: 'cmd:copy',
        label: '選択項目をコピー',
        description: 'Zero-Copy CoW コピー用にクリップボードへ格納します',
        shortcutHint: '⌘C',
        keywords: ['copy', 'コピー'],
        category: 'action',
      });
    }
    if (options.canCutTarget && options.hasTargetItem) {
      commands.push({
        id: 'cmd:cut',
        label: '選択項目を切り取り',
        description: '移動対象としてクリップボードへ切り取ります',
        shortcutHint: '⌘X',
        keywords: ['cut', '切り取り', '移動'],
        category: 'action',
      });
    }
    if (options.canDuplicateTarget && options.hasTargetItem) {
      commands.push({
        id: 'cmd:duplicate',
        label: '選択項目を複製',
        description: '同じフォルダ内に即座にコピーを作成します',
        shortcutHint: '⌘D',
        keywords: ['duplicate', '複製', 'コピー'],
        category: 'action',
      });
    }
    commands.push({
      id: 'cmd:new-folder',
      label: '新規フォルダを作成',
      description: '現在のディレクトリにフォルダを作成します',
      keywords: ['new', 'folder', 'create', '新規', 'フォルダ'],
      category: 'action',
    });
    commands.push({
      id: 'cmd:toggle-inspector',
      label: '詳細インスペクタを開閉',
      description: 'DLP継承元・権限・バージョン詳細パネルを表示/非表示にします',
      shortcutHint: 'i',
      keywords: ['inspector', 'details', '詳細', 'インスペクタ'],
      category: 'action',
    });
    commands.push({
      id: 'cmd:toggle-view',
      label: 'リスト / グリッド表示を切替',
      description: 'テーブル表示とカード型グリッド表示を切り替えます',
      shortcutHint: 'v',
      keywords: ['grid', 'list', 'view', '表示', 'グリッド', 'リスト'],
      category: 'action',
    });
    if (options.canClassifyTarget && options.hasTargetItem) {
      commands.push({
        id: 'cmd:change-classification',
        label: '区分を変更',
        description: '選択・フォーカス中ファイルの機密分類を変更します',
        shortcutHint: 'c',
        keywords: ['classification', 'label', '機密', '区分', '分類'],
        category: 'action',
      });
    }
    if (options.canShareTarget && options.hasTargetItem) {
      commands.push({
        id: 'cmd:share',
        label: '共有リンク作成',
        description: 'フォーカス中アイテムの共有リンク設定を開きます',
        shortcutHint: 's',
        keywords: ['share', 'link', '共有', 'リンク'],
        category: 'action',
      });
    }
    if (options.canTrashTarget && options.hasTargetItem) {
      commands.push({
        id: 'cmd:trash',
        label: 'ゴミ箱へ移動',
        description: '選択・フォーカス中のアイテムをゴミ箱へ移動します',
        shortcutHint: 'Del',
        keywords: ['trash', 'delete', 'ゴミ箱', '削除'],
        category: 'action',
      });
    }
    commands.push({
      id: 'cmd:shortcuts',
      label: 'ショートカット一覧を表示',
      description: 'キーボード操作のクイックリファレンスを開きます',
      shortcutHint: '?',
      keywords: ['shortcuts', 'help', 'keyboard', 'ヘルプ', 'ショートカット'],
      category: 'action',
    });
  }

  commands.push(
    {
      id: 'filter:confidential',
      label: 'フィルタ: 極秘 (is:confidential)',
      description: '極秘区分アイテムだけを抽出して表示します',
      keywords: ['is:confidential', 'confidential', '極秘', 'フィルタ'],
      category: 'filter',
    },
    {
      id: 'filter:internal',
      label: 'フィルタ: 社内限定 (is:internal)',
      description: '社内限定区分アイテムだけを抽出して表示します',
      keywords: ['is:internal', 'internal', '社内限定', 'フィルタ'],
      category: 'filter',
    },
    {
      id: 'filter:unset',
      label: 'フィルタ: 未設定 (is:unset)',
      description: 'AI分類候補を含む未設定アイテムを抽出します',
      keywords: ['is:unset', 'unset', '未設定', 'フィルタ'],
      category: 'filter',
    },
    {
      id: 'nav:workspace',
      label: 'マイファイルへ移動',
      description: 'ワークスペースのルートフォルダへ移動します',
      keywords: ['workspace', 'files', 'home', 'マイファイル'],
      category: 'navigation',
    },
    {
      id: 'nav:trash',
      label: 'ゴミ箱へ移動',
      description: '削除済みアイテム一覧を開きます',
      keywords: ['trash', 'ゴミ箱'],
      category: 'navigation',
    }
  );

  if (options.isAdmin) {
    commands.push({
      id: 'nav:admin',
      label: 'ガバナンス画面へ移動',
      description: 'AI提案キュー・異常監視コンソールを開きます',
      keywords: ['admin', 'governance', 'audit', 'ガバナンス', '管理'],
      category: 'navigation',
    });
  }

  commands.push({
    id: 'action:logout',
    label: 'サインアウト',
    description: 'ローカルキャッシュを消去してログアウトします',
    keywords: ['logout', 'signout', 'ログアウト', 'サインアウト'],
    category: 'navigation',
  });

  return commands;
}

function matchesCommand(cmd: PaletteCommand, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${cmd.label} ${cmd.description} ${cmd.keywords.join(' ')}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * Merges 0ms local cached workspace items, executable commands, and FTS5 remote hits
 * with strict ID deduplication across local files and FTS5 results.
 */
export function mergePaletteEntries(options: {
  query: string;
  commands: readonly PaletteCommand[];
  localFolders: ReadonlyArray<{ folder: FolderSummary; pathHint: string }>;
  localFiles: readonly SearchResultItem[];
  remoteResults: readonly SearchResultItem[];
  maxRecentLocal?: number;
}): PaletteEntry[] {
  const parsed = parseSearchQuery(options.query);
  const matchingCommands = options.commands.filter((cmd) =>
    matchesCommand(cmd, parsed.textTokens)
  );

  if (parsed.isCommandMode) {
    return matchingCommands.map((command) => ({
      kind: 'command',
      key: `cmd:${command.id}`,
      command,
    }));
  }

  const trimmed = options.query.trim();
  const entries: PaletteEntry[] = [];
  const seenFileIds = new Set<string>();

  if (!trimmed) {
    // Empty palette: show actions/navigation commands first, then recent cached folders/files in 0ms.
    for (const command of matchingCommands) {
      entries.push({
        kind: 'command',
        key: `cmd:${command.id}`,
        command,
      });
    }
    const maxRecent = options.maxRecentLocal ?? 8;
    let added = 0;
    for (const item of options.localFolders) {
      if (added >= maxRecent) break;
      entries.push({
        kind: 'local-folder',
        key: `local-folder:${item.folder.id}`,
        folder: item.folder,
        pathHint: item.pathHint,
      });
      added += 1;
    }
    for (const file of options.localFiles) {
      if (added >= maxRecent) break;
      seenFileIds.add(file.id);
      entries.push({
        kind: 'file',
        key: `file:${file.id}`,
        item: file,
        source: 'local',
      });
      added += 1;
    }
    return entries;
  }

  // Query mode: instant 0ms local folder/file matches first, then FTS5 deduped hits, then matching commands.
  for (const item of options.localFolders) {
    entries.push({
      kind: 'local-folder',
      key: `local-folder:${item.folder.id}`,
      folder: item.folder,
      pathHint: item.pathHint,
    });
  }

  for (const file of options.localFiles) {
    if (seenFileIds.has(file.id)) continue;
    seenFileIds.add(file.id);
    entries.push({
      kind: 'file',
      key: `file:${file.id}`,
      item: file,
      source: 'local',
    });
  }

  for (const remote of options.remoteResults) {
    if (seenFileIds.has(remote.id)) continue;
    seenFileIds.add(remote.id);
    entries.push({
      kind: 'file',
      key: `file:${remote.id}`,
      item: remote,
      source: 'fts5',
    });
  }

  for (const command of matchingCommands) {
    entries.push({
      kind: 'command',
      key: `cmd:${command.id}`,
      command,
    });
  }

  return entries;
}

