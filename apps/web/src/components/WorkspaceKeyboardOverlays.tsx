'use client';

import { Keyboard, Sparkles, Tag, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import {
  isImeComposingEvent,
  keyboardScopes,
} from '@/lib/keyboard-shortcuts';
import type { ClassificationLabel } from '@/types/files';

type AssignableClassification = Exclude<ClassificationLabel, 'unset'>;

const CLASSIFICATION_OPTIONS: Array<{
  value: AssignableClassification;
  shortcut: string;
  description: string;
}> = [
  {
    value: 'confidential',
    shortcut: '1',
    description: '透かし強制・ダウンロード/外部共有制限（最高機密）',
  },
  {
    value: 'internal',
    shortcut: '2',
    description: '組織メンバー内での共有・編集対象',
  },
  {
    value: 'public',
    shortcut: '3',
    description: '社外公開可能な資料',
  },
];

export function ClassificationPickerModal({
  targetLabel,
  currentClassification,
  aiSuggestedLabel,
  onSelect,
  onClose,
}: {
  targetLabel: string;
  currentClassification: ClassificationLabel | null;
  aiSuggestedLabel?: ClassificationLabel | null;
  onSelect: (classification: AssignableClassification) => void;
  onClose: () => void;
}) {
  const initialIndex = currentClassification
    ? Math.max(
        0,
        CLASSIFICATION_OPTIONS.findIndex(
          (opt) => opt.value === currentClassification
        )
      )
    : 0;
  const [cursorIndex, setCursorIndex] = useState(initialIndex);
  const scopeTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const token = keyboardScopes.pushScope('picker');
    scopeTokenRef.current = token;
    return () => {
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) {
        scopeTokenRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if (scopeTokenRef.current && !keyboardScopes.isTopToken(scopeTokenRef.current)) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setCursorIndex((prev) => (prev + 1) % CLASSIFICATION_OPTIONS.length);
        return;
      }
      if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCursorIndex(
          (prev) =>
            (prev - 1 + CLASSIFICATION_OPTIONS.length) %
            CLASSIFICATION_OPTIONS.length
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const picked = CLASSIFICATION_OPTIONS[cursorIndex];
        if (picked) onSelect(picked.value);
        return;
      }
      if (e.key >= '1' && e.key <= '3') {
        e.preventDefault();
        const picked = CLASSIFICATION_OPTIONS[Number(e.key) - 1];
        if (picked) onSelect(picked.value);
        return;
      }
      if (
        e.key.toLowerCase() === 'a' &&
        aiSuggestedLabel &&
        aiSuggestedLabel !== 'unset'
      ) {
        e.preventDefault();
        onSelect(aiSuggestedLabel);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cursorIndex, aiSuggestedLabel, onSelect, onClose]);

  return (
    <ModalShell
      label="機密区分を設定"
      onClose={onClose}
      className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Tag className="h-4 w-4 shrink-0 text-blue-600" />
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-slate-900">
                機密区分を設定
              </div>
              <div className="truncate text-[0.6875rem] text-slate-500">
                {targetLabel}
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="divide-y divide-slate-100 p-2">
          {aiSuggestedLabel && aiSuggestedLabel !== 'unset' && (
            <button
              type="button"
              onClick={() => onSelect(aiSuggestedLabel)}
              className="mb-1 flex w-full items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-2 text-left text-xs hover:bg-indigo-100/70"
            >
              <span className="flex items-center gap-2 font-medium text-indigo-800">
                <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
                <span>AI 提案を承認:</span>
                <ClassificationBadge classification={aiSuggestedLabel} compact />
              </span>
              <kbd className="rounded border border-indigo-200 bg-white px-1.5 py-0.5 font-mono text-[0.625rem] text-indigo-700">
                a
              </kbd>
            </button>
          )}

          {CLASSIFICATION_OPTIONS.map((opt, idx) => {
            const active = idx === cursorIndex;
            const selected = currentClassification === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                data-autofocus={active ? '' : undefined}
                onMouseEnter={() => setCursorIndex(idx)}
                onClick={() => onSelect(opt.value)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                  active ? 'bg-blue-50' : 'hover:bg-slate-50'
                }`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <ClassificationBadge classification={opt.value} compact />
                    {selected && (
                      <span className="text-[0.625rem] font-semibold text-blue-600">
                        現在値
                      </span>
                    )}
                  </div>
                  <p className="text-[0.6875rem] text-slate-500">{opt.description}</p>
                </div>
                <kbd className="shrink-0 rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[0.6875rem] text-slate-600">
                  {opt.shortcut}
                </kbd>
              </button>
            );
          })}
        </div>

        <div className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-[0.6875rem] text-slate-500">
          数字キー 1–3 / j・k / Enter で即適用 • Esc でキャンセル
        </div>
    </ModalShell>
  );
}

const SHORTCUT_GROUPS: Array<{
  title: string;
  items: Array<{ keys: string[]; desc: string }>;
}> = [
  {
    title: 'ナビゲーション & 表示',
    items: [
      { keys: ['j', '↓'], desc: '次の行 / カードへ移動' },
      { keys: ['k', '↑'], desc: '前の行 / カードへ移動' },
      { keys: ['Home', 'End'], desc: '先頭 / 末尾へジャンプ' },
      { keys: ['Enter', 'l'], desc: 'フォルダを開く / ファイルプレビュー' },
      { keys: ['Backspace', 'h'], desc: '親フォルダへ戻る' },
      { keys: ['Space'], desc: 'クイックプレビュー開閉' },
      { keys: ['i'], desc: '詳細インスペクタ開閉' },
      { keys: ['v'], desc: 'リスト / グリッド表示切替' },
      { keys: ['⌘K'], desc: 'ハイブリッドコマンド & 横断検索' },
    ],
  },
  {
    title: '選択・コピー・移動・編集',
    items: [
      { keys: ['x'], desc: 'カーソル行の選択 / 解除' },
      { keys: ['Shift+↑↓', 'Shift+JK'], desc: '範囲選択を拡張' },
      { keys: ['Shift+Click'], desc: 'クリック範囲選択' },
      { keys: ['⌘A'], desc: '表示中の全行を選択' },
      { keys: ['⌘C', '⌘X', '⌘V'], desc: 'コピー / 切り取り / 貼り付け (OS画像可)' },
      { keys: ['⌘D'], desc: 'その場で複製 (Zero-Copy)' },
      { keys: ['m'], desc: '移動 / コピー先ツリーを開く' },
      { keys: ['F2', 'r'], desc: 'その場でインライン改名' },
      { keys: ['c', 's', 'd'], desc: '機密区分 / 共有 / ダウンロード' },
      { keys: ['Shift+F10'], desc: 'コンテキストメニューを開く' },
      { keys: ['Del', '⌘⌫'], desc: 'ゴミ箱へ移動' },
      { keys: ['⌘Z'], desc: '直前の操作を取り消す (Undo)' },
      { keys: ['Esc'], desc: 'オーバーレイ → 選択 → クリップボード順に解除' },
    ],
  },
  {
    title: 'プレビュー中',
    items: [
      { keys: ['←', '→'], desc: 'PDF ページ送り' },
      { keys: ['↑', '↓'], desc: '同フォルダ内の前後ファイルへ切替' },
      { keys: ['Space', 'Esc'], desc: 'プレビューを閉じる' },
      { keys: ['?'], desc: 'ショートカット一覧を表示 / 閉じる' },
    ],
  },
];

export function ShortcutsHelpModal({ onClose }: { onClose: () => void }) {
  const scopeTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const token = keyboardScopes.pushScope('help');
    scopeTokenRef.current = token;
    return () => {
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) {
        scopeTokenRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if (scopeTokenRef.current && !keyboardScopes.isTopToken(scopeTokenRef.current)) {
        return;
      }
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <ModalShell
      label="キーボードショートカット"
      onClose={onClose}
      className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Keyboard className="h-4 w-4 text-blue-600" />
            <span>キーボードショートカット</span>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid gap-5 p-5 md:grid-cols-3">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="space-y-2.5">
              <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
                {group.title}
              </h3>
              <ul className="space-y-2">
                {group.items.map((item) => (
                  <li
                    key={item.desc}
                    className="flex items-start justify-between gap-2 text-xs"
                  >
                    <span className="text-slate-700">{item.desc}</span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1">
                      {item.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-700"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="border-t border-slate-100 bg-slate-50 px-5 py-2.5 text-[0.6875rem] text-slate-500">
          日本語 IME 変換中・入力フォーカス中・モーダル表示中は単キーショートカットを自動無効化します
        </footer>
    </ModalShell>
  );
}
