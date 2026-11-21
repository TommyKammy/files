'use client';

import {
  Archive,
  ArchiveRestore,
  Loader2,
  UserCog,
  Users,
} from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { formatAuditDateTime, formatBytes } from '@/lib/formatters';
import type { AdminRootFolderRecord } from '@/types/files';

export interface RootFolderModalState {
  kind: 'create' | 'transfer' | 'coowners' | 'archive' | 'restore';
  root: AdminRootFolderRecord | null;
}

export function RootFoldersTable({
  roots,
  loading,
  canMutate,
  onOpenModal,
}: {
  roots: AdminRootFolderRecord[];
  loading: boolean;
  canMutate: boolean;
  onOpenModal: (next: RootFolderModalState) => void;
}) {
  return (
    <>
      <div
        role="region"
        aria-labelledby="admin-root-folders-table-caption"
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-slate-200"
      >
        <table className="w-full min-w-[980px] text-left text-xs">
          <caption
            id="admin-root-folders-table-caption"
            className="sr-only"
          >
            ルートフォルダ一覧（所有者・共同所有者・容量・状態）
          </caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2.5">
                フォルダ
              </th>
              <th scope="col" className="px-3 py-2.5">
                所有者
              </th>
              <th scope="col" className="px-3 py-2.5">
                共同所有者
              </th>
              <th scope="col" className="px-3 py-2.5">
                作成者
              </th>
              <th scope="col" className="px-3 py-2.5">
                アイテム / 容量
              </th>
              <th scope="col" className="px-3 py-2.5">
                更新日
              </th>
              <th scope="col" className="px-3 py-2.5">
                状態
              </th>
              <th scope="col" className="px-3 py-2.5">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {roots.map((root) => (
              <tr
                key={root.id}
                data-testid="admin-root-folder-row"
                className={root.deletedAt ? 'bg-slate-50/70' : undefined}
              >
                <th
                  scope="row"
                  className="px-3 py-2.5 text-left align-top font-medium text-slate-900"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{root.name}</span>
                    <ClassificationBadge
                      classification={root.classification}
                      compact
                    />
                  </span>
                  <span className="mt-0.5 block font-mono text-[0.625rem] text-slate-500">
                    {root.id.slice(0, 12)}
                  </span>
                </th>
                <td className="px-3 py-2.5 align-top">
                  {root.owners.length === 0 ? (
                    <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[0.625rem] font-semibold text-red-700">
                      所有者不在
                    </span>
                  ) : (
                    <ul className="space-y-1">
                      {root.owners.map((owner) => (
                        <li
                          key={`owner:${owner.granteeType}:${owner.granteeId}`}
                          className="flex flex-wrap items-center gap-1"
                        >
                          <span className="font-medium text-slate-800">
                            {owner.name}
                          </span>
                          {owner.email && (
                            <span className="text-[0.625rem] text-slate-500">
                              {owner.email}
                            </span>
                          )}
                          {owner.status === 'suspended' && (
                            <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[0.625rem] font-semibold text-red-700">
                              停止ユーザー
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {root.ownerMissing && root.owners.length > 0 && (
                    <span className="mt-1 inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[0.625rem] font-semibold text-red-700">
                      所有者不在
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 align-top text-slate-700">
                  {root.coOwners.length === 0 ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {root.coOwners.map((coOwner) => (
                        <li
                          key={`coowner:${coOwner.granteeType}:${coOwner.granteeId}`}
                          className="flex items-center gap-1"
                        >
                          <span>{coOwner.name}</span>
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[0.625rem] text-slate-600">
                            {coOwner.granteeType === 'group'
                              ? 'グループ'
                              : 'ユーザー'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-3 py-2.5 align-top text-[0.6875rem] text-slate-600">
                  <span className="block">{root.createdByName}</span>
                  <span className="block text-[0.625rem] text-slate-500">
                    {root.createdByEmail}
                  </span>
                </td>
                <td className="px-3 py-2.5 align-top text-[0.6875rem] text-slate-600">
                  <span className="block">
                    {root.itemCount.toLocaleString('ja-JP')} 件
                  </span>
                  <span className="block text-[0.625rem] text-slate-500">
                    {formatBytes(root.totalBytes)}
                  </span>
                </td>
                <td className="px-3 py-2.5 align-top whitespace-nowrap text-[0.6875rem] text-slate-600">
                  <time dateTime={root.updatedAt}>
                    {formatAuditDateTime(root.updatedAt)}
                  </time>
                </td>
                <td className="px-3 py-2.5 align-top">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
                      root.deletedAt
                        ? 'bg-slate-200 text-slate-700'
                        : 'bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    {root.deletedAt ? 'アーカイブ済み' : '有効'}
                  </span>
                </td>
                <td className="px-3 py-2.5 align-top">
                  {canMutate ? (
                    <div className="flex flex-wrap gap-1">
                      {root.deletedAt === null ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              onOpenModal({ kind: 'transfer', root })
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <UserCog className="h-3 w-3" />
                            所有者移管
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onOpenModal({ kind: 'coowners', root })
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Users className="h-3 w-3" />
                            グループ/共同所有者
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onOpenModal({ kind: 'archive', root })
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-amber-800 hover:bg-amber-50"
                          >
                            <Archive className="h-3 w-3" />
                            アーカイブ
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onOpenModal({ kind: 'restore', root })}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-emerald-800 hover:bg-emerald-50"
                        >
                          <ArchiveRestore className="h-3 w-3" />
                          復元
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-[0.625rem] text-slate-500">
                      読み取りのみ
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && roots.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-10 text-center text-[0.6875rem] text-slate-500"
                >
                  条件に一致するルートフォルダがありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {loading && (
        <p className="flex items-center gap-1.5 text-[0.6875rem] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ルートフォルダを読み込み中...
        </p>
      )}
    </>
  );
}
