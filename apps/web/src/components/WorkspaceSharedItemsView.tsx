'use client';

import {
  AlertTriangle,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Route,
  Share2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { TosAcceptanceModal } from '@/components/TosAcceptanceModal';
import { canAccess, ROLE_META } from '@/lib/capabilities';
import { listSharedItems } from '@/lib/files-api';
import { useTosAcceptance } from '@/lib/use-tos-acceptance';
import {
  guestSessionIssueFromError,
  type GuestSessionIssue,
} from '@/lib/guest-collaboration';
import { formatDateTime } from '@/lib/formatters';
import type { SharedItemEntry } from '@/types/files';

export function WorkspaceSharedItemsView({
  onOpenFolder,
  onOpenFile,
  isGuest = false,
  externalOrg = null,
  expiresAt = null,
}: {
  onOpenFolder: (folderId: string) => void;
  onOpenFile: (fileId: string) => void;
  isGuest?: boolean;
  externalOrg?: string | null;
  expiresAt?: string | null;
}) {
  const [items, setItems] = useState<SharedItemEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [sessionIssue, setSessionIssue] = useState<GuestSessionIssue | null>(
    null
  );
  const tosGate = useTosAcceptance({ apiErrorCode: errorCode });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setSessionIssue(null);
    try {
      const res = await listSharedItems(200, signal);
      setItems(res.items);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setErrorCode(
        typeof (err as { code?: unknown })?.code === 'string'
          ? ((err as { code: string }).code)
          : null
      );
      setSessionIssue(
        isGuest
          ? guestSessionIssueFromError(err, { userType: 'guest' })
          : null
      );
      setError(
        err instanceof Error
          ? err.message
          : '共有アイテムの取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }, [isGuest]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function openItem(item: SharedItemEntry) {
    if (item.itemType === 'folder') {
      onOpenFolder(item.id);
      return;
    }
    if (canAccess({ capabilities: item.capabilities }, 'item.preview')) {
      onOpenFile(item.id);
      return;
    }
    if (item.folderId) onOpenFolder(item.folderId);
  }

  return (
    <>
      {tosGate.blocked && (
        <TosAcceptanceModal
          tos={tosGate.status}
          branding={tosGate.branding}
          accepting={tosGate.accepting}
          error={tosGate.error}
          onAccept={() => void tosGate.accept()}
        />
      )}
      <section aria-labelledby="shared-items-heading" className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1
              id="shared-items-heading"
              className="flex items-center gap-2 text-[1rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              <Share2 className="h-4 w-4 text-[#5e6ad2]" />
              共有アイテム
            </h1>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-[#6b6f76]">
              あなたまたは所属グループに直接共有されたフォルダとファイルです。継承のみのアイテムは含まれません。
            </p>
            {isGuest && (
            <div
              data-testid="guest-shared-guidance"
              className="mt-2 min-w-0 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900"
            >
              <p className="break-words font-semibold">
                外部ゲストとしてサインイン中
              </p>
              <p className="break-words">
                外部組織: {externalOrg ?? '未設定'} / アカウント有効期限:{' '}
                {formatDateTime(expiresAt)}
              </p>
              <p className="break-words">
                共有アイテムのみ表示されます。権限管理・削除・ルートフォルダ作成はできません。操作範囲は各フォルダの実効ロールに従います。
              </p>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>再読み込み</span>
        </button>
      </header>

      {sessionIssue ? (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="guest-shared-session-issue"
          data-code={sessionIssue.code}
          className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
        >
          <div className="min-w-0 space-y-1">
            <p className="break-words font-semibold">{sessionIssue.title}</p>
            <p className="break-words leading-relaxed">
              {sessionIssue.description}
            </p>
          </div>
          <a
            href={sessionIssue.actionHref}
            className="inline-flex min-h-8 shrink-0 items-center rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
          >
            {sessionIssue.actionLabel} (/guest/login)
          </a>
        </div>
      ) : error ? (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      <div
        role="region"
        aria-label="共有アイテム一覧"
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-[#e7e7ea] bg-white focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
      >
        <table className="w-full min-w-[720px] border-collapse text-left text-[0.75rem]">
          <caption className="sr-only">
            直接共有されたフォルダとファイルの一覧。名前、種別、階層パス、ロール、更新日時を表示します。
          </caption>
          <thead>
            <tr className="border-b border-[#ececee] text-[0.6875rem] text-[#6b6f76]">
              <th scope="col" className="px-4 py-2 font-medium">
                名前
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                種別
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                階層パス
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                ロール
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                更新日時
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-[#6b6f76]">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin text-blue-600" />
                  共有アイテムを読み込み中...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center">
                  <p className="font-medium text-[#111214]">
                    直接共有されたアイテムはありません
                  </p>
                  <p className="mt-1 text-[0.6875rem] text-[#6b6f76]">
                    フォルダまたはファイルの権限画面から共有すると、ここに表示されます。
                  </p>
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const roleLabel = item.effectiveRole
                  ? ROLE_META[item.effectiveRole]?.label ?? item.effectiveRole
                  : '—';
                return (
                  <tr
                    key={`${item.itemType}:${item.id}`}
                    data-testid="shared-item-row"
                    className="border-b border-[#f2f2f4] last:border-b-0 hover:bg-[#f7f7f9]"
                  >
                    <th scope="row" className="px-4 py-2.5 text-left font-medium">
                      <button
                        type="button"
                        onClick={() => openItem(item)}
                        className="flex min-w-0 items-center gap-2 text-left text-[#111214] transition hover:text-[#4f5ac2]"
                      >
                        {item.itemType === 'folder' ? (
                          <Folder className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                        )}
                        <span className="truncate">{item.name}</span>
                        <ClassificationBadge
                          classification={item.classification}
                          compact
                        />
                      </button>
                    </th>
                    <td className="px-3 py-2.5 text-[#3c3f46]">
                      {item.itemType === 'folder' ? 'フォルダ' : 'ファイル'}
                    </td>
                    <td className="px-3 py-2.5 text-[#3c3f46]">
                      <span className="inline-flex items-center gap-1">
                        <Route className="h-3.5 w-3.5 shrink-0 text-[#8a8d94]" />
                        <span data-testid="shared-item-path">{item.pathLabel}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                        {roleLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[#55565a]">
                      {formatDateTime(item.updatedAt)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      </section>
    </>
  );
}
