'use client';

import { Loader2, Search, UserPlus, Users } from 'lucide-react';
import type { FormEvent } from 'react';
import { CapabilityChips } from '@/components/permissions/CapabilityChips';
import { ROLE_CAPABILITY_CHIPS, ROLE_META } from '@/lib/capabilities';
import { formatDateTime } from '@/lib/formatters';
import type {
  GuestPolicyProjection,
  PrincipalCandidate,
  ResourceRole,
} from '@/types/files';

const FILE_ROLE_NOTE =
  '投稿系ロール (Uploader / Previewer + Uploader / Viewer + Uploader) はフォルダ専用です。ファイルには Owner / Co-Owner / Editor / Viewer / Previewer のみ付与できます。';

export interface RoleGroupOption {
  id: string;
  label: string;
  roles: ResourceRole[];
}

export function PermissionGrantForm({
  targetType,
  advancedRolesEnabled,
  query,
  setQuery,
  candidates,
  setCandidates,
  searching,
  selectedPrincipal,
  setSelectedPrincipal,
  selectedPrincipalLock,
  safeRole,
  setRole,
  roleGroups,
  guestSelected,
  guestAssignableRoles,
  guestPolicy,
  submitting,
  onSubmit,
}: {
  targetType: 'folder' | 'file';
  advancedRolesEnabled: boolean;
  query: string;
  setQuery: (query: string) => void;
  candidates: PrincipalCandidate[];
  setCandidates: (candidates: PrincipalCandidate[]) => void;
  searching: boolean;
  selectedPrincipal: PrincipalCandidate | null;
  setSelectedPrincipal: (principal: PrincipalCandidate | null) => void;
  selectedPrincipalLock: {
    sourceName: string;
    role: ResourceRole;
    inherited: boolean;
  } | null;
  safeRole: ResourceRole;
  setRole: (role: ResourceRole) => void;
  roleGroups: RoleGroupOption[];
  guestSelected: boolean;
  guestAssignableRoles: ResourceRole[];
  guestPolicy: GuestPolicyProjection | null;
  submitting: boolean;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
      aria-describedby="permission-role-description"
    >
      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold text-slate-700">
          ユーザーまたは SCIM グループを追加
        </legend>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <label htmlFor="permission-principal-search" className="sr-only">
              ユーザーまたはグループを検索
            </label>
            <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
            <input
              id="permission-principal-search"
              name="principalSearch"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={
                !selectedPrincipal && (searching || candidates.length > 0)
              }
              aria-controls="permission-principal-listbox"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              type="text"
              value={
                selectedPrincipal
                  ? `${selectedPrincipal.name}${
                      selectedPrincipal.email
                        ? ` (${selectedPrincipal.email})`
                        : ''
                    }`
                  : query
              }
              onChange={(e) => {
                setSelectedPrincipal(null);
                setQuery(e.target.value);
              }}
              placeholder="氏名・メールアドレス・グループ名で検索"
              className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />

            {!selectedPrincipal && (searching || candidates.length > 0) && (
              <div
                id="permission-principal-listbox"
                role="listbox"
                aria-label="検索候補"
                className="absolute left-0 right-0 z-20 mt-1 max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
              >
                {searching ? (
                  <div className="px-3 py-2 text-xs text-slate-500">
                    検索中...
                  </div>
                ) : (
                  candidates.map((cand) => (
                    <button
                      key={`${cand.type}:${cand.id}`}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        setSelectedPrincipal(cand);
                        setCandidates([]);
                      }}
                      className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-blue-50"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-slate-800">
                        {cand.type === 'group' ? (
                          <Users className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                        ) : (
                          <UserPlus className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                        )}
                        <span className="min-w-0 break-words">{cand.name}</span>
                        {cand.userType === 'guest' && (
                          <span
                            data-testid="principal-guest-badge"
                            className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-800"
                          >
                            外部ゲスト
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 break-all text-[0.6875rem] text-slate-600">
                        {cand.email ?? 'SCIM Group'}
                      </span>
                      {cand.userType === 'guest' && (
                        <span className="min-w-0 break-words text-[0.625rem] text-amber-800">
                          {cand.externalOrg ?? '外部組織未設定'}
                          {cand.expiresAt
                            ? ` / 有効期限: ${formatDateTime(cand.expiresAt)}`
                            : ''}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="sm:w-56">
            <label
              htmlFor="permission-role"
              className="mb-1 block text-[0.6875rem] font-medium text-slate-600"
            >
              付与するロール
            </label>
            <select
              id="permission-role"
              name="role"
              value={safeRole}
              disabled={
                Boolean(selectedPrincipalLock) ||
                (guestSelected && guestAssignableRoles.length === 0)
              }
              onChange={(e) => setRole(e.target.value as ResourceRole)}
              aria-describedby="permission-role-description"
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50"
            >
              {roleGroups.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.roles.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {ROLE_META[candidate].label} —{' '}
                      {ROLE_META[candidate].description}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={
              !selectedPrincipal ||
              submitting ||
              Boolean(selectedPrincipalLock) ||
              (guestSelected && guestAssignableRoles.length === 0)
            }
            title={
              selectedPrincipalLock
                ? `親フォルダ「${selectedPrincipalLock.sourceName}」で変更してください`
                : undefined
            }
            className="inline-flex items-center justify-center gap-1.5 self-end rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:mb-0"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>付与</span>
          </button>
        </div>

        <div
          id="permission-role-description"
          aria-live="polite"
          className="space-y-1.5 rounded-lg border border-slate-200 bg-white p-2.5"
        >
          <p className="text-[0.6875rem] text-slate-700">
            <span className="font-semibold">{ROLE_META[safeRole].label}</span>:{' '}
            {ROLE_META[safeRole].description}
          </p>
          <CapabilityChips
            capabilityLabels={ROLE_CAPABILITY_CHIPS[safeRole]}
            ariaLabel={`${ROLE_META[safeRole].label} の権限`}
          />
          {guestSelected && (
            <div
              role="note"
              data-testid="guest-role-constraints"
              className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[0.625rem] leading-relaxed text-amber-900"
            >
              <p className="break-words font-semibold">外部ゲストのロール制約</p>
              <ul className="list-disc space-y-0.5 pl-3">
                <li className="break-words">
                  Owner / Co-Owner は選択できません。
                </li>
                {!guestPolicy?.allowGuestElevatedRoles && (
                  <li className="break-words">
                    Editor は既定のゲストポリシーでは選択できません。
                  </li>
                )}
                {targetType === 'file' && (
                  <li className="break-words">
                    投稿系ロールはフォルダ専用のため選択できません。
                  </li>
                )}
                <li className="break-words">
                  共有リンクとは異なり、ゲストはアカウント単位で有効期限・監査ログの対象です。
                </li>
              </ul>
              {guestAssignableRoles.length === 0 && (
                <p className="break-words font-medium text-red-800">
                  このゲストに付与できるロールがありません。
                </p>
              )}
            </div>
          )}
        </div>
      </fieldset>

      {targetType === 'file' ? (
        <p
          id="permission-file-role-note"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-800"
        >
          {FILE_ROLE_NOTE}
        </p>
      ) : !advancedRolesEnabled ? (
        <p
          id="permission-advanced-roles-disabled"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-800"
        >
          高度ロール (Uploader / Previewer + Uploader / Viewer + Uploader)
          は現在テナントポリシーで無効です。
          <span className="font-semibold">/admin</span>{' '}
          のアクセス制御設定で有効化してください。既存の付与は保持されます。
        </p>
      ) : null}
    </form>
  );
}
