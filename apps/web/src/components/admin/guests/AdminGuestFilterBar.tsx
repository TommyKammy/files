'use client';

import { RotateCcw, Search } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { AdminGuestStatusFilter } from '@/types/files';

export interface GuestDraftFilters {
  query: string;
  status: AdminGuestStatusFilter;
  domain: string;
  invitedBy: string;
  expiresBefore: string;
}

interface AdminGuestFilterBarProps {
  draft: GuestDraftFilters;
  setDraft: Dispatch<SetStateAction<GuestDraftFilters>>;
  onApply: () => void;
  onReset: () => void;
}

export function AdminGuestFilterBar({
  draft,
  setDraft,
  onApply,
  onReset,
}: AdminGuestFilterBarProps) {
  return (
    <search>
      <form
        aria-label="ゲスト一覧のフィルタ"
        onSubmit={(event) => {
          event.preventDefault();
          onApply();
        }}
        className="mb-3 grid gap-2 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3 md:grid-cols-2 lg:grid-cols-6"
      >
        <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
          検索
          <input
            type="search"
            name="guestQuery"
            data-testid="guest-filter-query"
            value={draft.query}
            onChange={(event) =>
              setDraft((current) => ({ ...current, query: event.target.value }))
            }
            placeholder="メール / 表示名 / 組織 / ID"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
          />
        </label>
        <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
          ステータス
          <select
            name="guestStatus"
            data-testid="guest-filter-status"
            value={draft.status}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                status: event.target.value as AdminGuestStatusFilter,
              }))
            }
            className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
          >
            <option value="all">すべて</option>
            <option value="active">有効</option>
            <option value="pending_invite">招待中</option>
            <option value="expired">期限切れ</option>
            <option value="suspended">停止中</option>
            <option value="offboarded">オフボーディング済み</option>
          </select>
        </label>
        <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
          ドメイン
          <input
            type="text"
            name="guestDomain"
            data-testid="guest-filter-domain"
            value={draft.domain}
            onChange={(event) =>
              setDraft((current) => ({ ...current, domain: event.target.value }))
            }
            placeholder="partner.example"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
          />
        </label>
        <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
          招待者
          <input
            type="text"
            name="guestInvitedBy"
            data-testid="guest-filter-invited-by"
            value={draft.invitedBy}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                invitedBy: event.target.value,
              }))
            }
            placeholder="ID / メール / 表示名"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
          />
        </label>
        <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
          期限日 (以前)
          <input
            type="date"
            name="guestExpiresBefore"
            data-testid="guest-filter-expires-before"
            value={draft.expiresBefore}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                expiresBefore: event.target.value,
              }))
            }
            className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
          />
        </label>
        <div className="flex items-end gap-1.5">
          <button
            type="submit"
            data-testid="guest-filter-apply"
            className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2]"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            絞り込む
          </button>
          <button
            type="button"
            data-testid="guest-filter-reset"
            onClick={onReset}
            className="inline-flex h-8 items-center justify-center rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">フィルタをリセット</span>
          </button>
        </div>
      </form>
    </search>
  );
}
