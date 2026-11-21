'use client';

import { ShieldAlert, UserCheck } from 'lucide-react';
import type { AdminGuestStatusFilter } from '@/types/files';

export interface GuestStatusSummaryCard {
  status: AdminGuestStatusFilter;
  label: string;
  count: number;
}

export interface GuestDomainSummaryRow {
  domain: string;
  count: number;
  active: number;
  suspended: number;
  expired: number;
  allowedByPolicy: boolean;
  statusLabel: string;
  warning: string | null;
}

export interface GuestInviterSummaryRow {
  inviterId: string;
  displayName: string;
  count: number;
  active: number;
  suspended: number;
  expired: number;
}

interface AdminGuestSummarySectionProps {
  statusCards: GuestStatusSummaryCard[];
  domainRows: GuestDomainSummaryRow[];
  inviterRows: GuestInviterSummaryRow[];
}

export function AdminGuestSummarySection({
  statusCards,
  domainRows,
  inviterRows,
}: AdminGuestSummarySectionProps) {
  return (
    <>
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {statusCards.map((card) => (
          <div
            key={card.status}
            data-testid={`guest-summary-status-${card.status}`}
            className="rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] px-3 py-2"
          >
            <p className="text-[0.625rem] text-[#55565a]">{card.label}</p>
            <p className="text-[1rem] font-semibold text-[#111214]">
              {card.count}
              <span className="ml-1 text-[0.625rem] font-normal text-[#55565a]">
                件
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-[#111214]">
            <ShieldAlert className="h-3.5 w-3.5 text-[#5e6ad2]" aria-hidden="true" />
            ドメイン別集計
          </h3>
          <div
            role="region"
            aria-label="ゲストのドメイン別集計"
            tabIndex={0}
            className="max-h-56 overflow-auto rounded-xl border border-[#e7e7ea]"
          >
            <table className="w-full text-left text-[0.6875rem]">
              <caption className="sr-only">
                ゲストのドメイン別件数・状態・許可リスト適合
              </caption>
              <thead className="sticky top-0 bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">ドメイン</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">件数</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">有効</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">停止</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">期限切れ</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">ポリシー</th>
                </tr>
              </thead>
              <tbody>
                {domainRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-3 text-center text-[#55565a]">
                      ドメイン集計はありません。
                    </td>
                  </tr>
                ) : (
                  domainRows.map((row) => (
                    <tr
                      key={row.domain}
                      data-testid="guest-domain-summary-row"
                      className="border-t border-[#f2f2f4]"
                    >
                      <td className="px-2 py-1.5 font-mono text-[0.625rem] text-[#111214]">
                        {row.domain}
                      </td>
                      <td className="px-2 py-1.5 text-[#3c3f46]">{row.count}</td>
                      <td className="px-2 py-1.5 text-emerald-700">{row.active}</td>
                      <td className="px-2 py-1.5 text-red-700">{row.suspended}</td>
                      <td className="px-2 py-1.5 text-amber-800">{row.expired}</td>
                      <td className="px-2 py-1.5">
                        <span
                          title={row.warning ?? undefined}
                          className={`inline-flex rounded-full border px-1.5 py-0.5 text-[0.5625rem] font-semibold ${
                            row.allowedByPolicy
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : 'border-red-200 bg-red-50 text-red-800'
                          }`}
                        >
                          {row.statusLabel}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-[#111214]">
            <UserCheck className="h-3.5 w-3.5 text-[#5e6ad2]" aria-hidden="true" />
            招待者別集計
          </h3>
          <div
            role="region"
            aria-label="ゲストの招待者別集計"
            tabIndex={0}
            className="max-h-56 overflow-auto rounded-xl border border-[#e7e7ea]"
          >
            <table className="w-full text-left text-[0.6875rem]">
              <caption className="sr-only">
                ゲストの招待者別件数・状態
              </caption>
              <thead className="sticky top-0 bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">招待者</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">件数</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">有効</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">停止</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">期限切れ</th>
                </tr>
              </thead>
              <tbody>
                {inviterRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-3 text-center text-[#55565a]">
                      招待者集計はありません。
                    </td>
                  </tr>
                ) : (
                  inviterRows.map((row) => (
                    <tr
                      key={row.inviterId}
                      data-testid="guest-inviter-summary-row"
                      className="border-t border-[#f2f2f4]"
                    >
                      <td className="px-2 py-1.5 text-[#111214]">{row.displayName}</td>
                      <td className="px-2 py-1.5 text-[#3c3f46]">{row.count}</td>
                      <td className="px-2 py-1.5 text-emerald-700">{row.active}</td>
                      <td className="px-2 py-1.5 text-red-700">{row.suspended}</td>
                      <td className="px-2 py-1.5 text-amber-800">{row.expired}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
