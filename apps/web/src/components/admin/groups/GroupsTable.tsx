'use client';

import { Loader2 } from 'lucide-react';
import { GroupSourceBadge } from '@/components/admin/groups/GroupSourceBadge';
import { formatAuditDateTime } from '@/lib/formatters';
import type { AdminGroupListResponse } from '@/types/files';

export function GroupsTable({
  rows,
  loading,
  onOpenDetail,
}: {
  rows: AdminGroupListResponse['groups'];
  loading: boolean;
  onOpenDetail: (groupId: string) => void;
}) {
  return (
    <div
      role="region"
      aria-label="グループ一覧"
      tabIndex={0}
      className="overflow-x-auto rounded-xl border border-[#e7e7ea]"
    >
      <table
        data-testid="admin-groups-table"
        className="w-full min-w-[52rem] border-collapse text-left text-[0.6875rem]"
      >
        <caption className="sr-only">
          テナント内の手動グループと SCIM 同期グループ。
        </caption>
        <thead className="bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              グループ
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              種別
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              メンバー
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              権限
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              IdP 外部 ID
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              作成日時
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-[#55565a]">
                <Loader2
                  className="mr-1.5 inline h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
                グループを読み込み中...
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                data-testid="group-empty"
                className="px-3 py-6 text-center text-[#55565a]"
              >
                条件に一致するグループはありません。
              </td>
            </tr>
          ) : (
            rows.map((group) => (
              <tr
                key={group.id}
                data-testid="admin-group-row"
                data-group-id={group.id}
                className="border-t border-[#f2f2f4]"
              >
                <td className="px-3 py-2">
                  <p className="font-medium text-[#111214]">{group.name}</p>
                  <p className="font-mono text-[0.5625rem] text-[#8a8b90]">
                    {group.id}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <GroupSourceBadge source={group.source} />
                </td>
                <td className="px-3 py-2 text-[#3c3f46]">
                  {group.memberCount} 人
                </td>
                <td className="px-3 py-2 text-[#3c3f46]">
                  {group.permissionCount} 件
                </td>
                <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-[0.625rem] text-[#55565a]">
                  {group.externalIdpId ?? '—'}
                </td>
                <td className="px-3 py-2 text-[#55565a]">
                  {formatAuditDateTime(group.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    data-testid="group-open-detail"
                    onClick={() => onOpenDetail(group.id)}
                    className="inline-flex items-center gap-1 rounded border border-[#d7d7dc] bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
                  >
                    詳細
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
