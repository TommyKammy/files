'use client';

import { Loader2, Search, Shield, Trash2, UserPlus, Users } from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import { usePermissionsModal } from '@/lib/use-permissions-modal';
import { ROLE_META } from '@/lib/formatters';
import type { ResourceRole } from '@/types/files';

const ASSIGNABLE_ROLES: ResourceRole[] = [
  'viewer',
  'previewer',
  'editor',
  'co_owner',
  'owner',
];

export function PermissionsModal({
  targetType,
  targetId,
  targetName,
  effectiveRole,
  onClose,
}: {
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  effectiveRole: ResourceRole;
  onClose: () => void;
}) {
  const {
    permissions,
    loading,
    error,
    query,
    setQuery,
    candidates,
    setCandidates,
    searching,
    selectedPrincipal,
    setSelectedPrincipal,
    role,
    setRole,
    submitting,
    canManage,
    handleGrant,
    handleRevoke,
  } = usePermissionsModal({ targetType, targetId, effectiveRole });

  return (
    <ModalShell
      label={`アクセス権限: ${targetName}`}
      onClose={onClose}
      className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <ModalHeader
          icon={<Shield className="h-4 w-4 shrink-0 text-blue-600" />}
          title={`アクセス権限: ${targetName}`}
          subtitle={`あなたの実効ロール: ${ROLE_META[effectiveRole]?.label ?? effectiveRole}`}
          onClose={onClose}
        />

        <div className="max-h-[75vh] overflow-y-auto p-5 space-y-5">
          <ModalError message={error} />

          {canManage && (
            <form
              onSubmit={handleGrant}
              className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
            >
              <div className="text-xs font-semibold text-slate-700">
                ユーザーまたは SCIM グループを追加
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
                  <input
                    id="permission-principal-search"
                    name="principalSearch"
                    role="combobox"
                    aria-label="ユーザーまたはグループを検索"
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
                            selectedPrincipal.email ? ` (${selectedPrincipal.email})` : ''
                          }`
                        : query
                    }
                    onChange={(e) => {
                      setSelectedPrincipal(null);
                      setQuery(e.target.value);
                    }}
                    placeholder="氏名・メールアドレス・グループ名で検索"
                    className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                  />

                  {!selectedPrincipal && (searching || candidates.length > 0) && (
                    <div
                      id="permission-principal-listbox"
                      role="listbox"
                      aria-label="検索候補"
                      className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg divide-y divide-slate-100"
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
                            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-blue-50"
                          >
                            <span className="flex items-center gap-2 font-medium text-slate-800">
                              {cand.type === 'group' ? (
                                <Users className="h-3.5 w-3.5 text-indigo-500" />
                              ) : (
                                <UserPlus className="h-3.5 w-3.5 text-blue-500" />
                              )}
                              <span>{cand.name}</span>
                            </span>
                            <span className="text-[0.6875rem] text-slate-600">
                              {cand.email ?? 'SCIM Group'}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <select
                  id="permission-role"
                  name="role"
                  aria-label="付与するロール"
                  value={role}
                  onChange={(e) => setRole(e.target.value as ResourceRole)}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800"
                >
                  {ASSIGNABLE_ROLES.filter(
                    (r) => r !== 'owner' || effectiveRole === 'owner'
                  ).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_META[r].label} — {ROLE_META[r].description}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={!selectedPrincipal || submitting}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>付与</span>
                </button>
              </div>
            </form>
          )}

          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-600">
              割り当て済み権限 ({permissions.length})
            </div>

            {loading ? (
              <div className="py-8 text-center text-xs text-slate-500">
                読み込み中...
              </div>
            ) : permissions.length === 0 ? (
              <div className="rounded-lg border border-slate-200 py-6 text-center text-xs text-slate-500">
                表示できる権限はありません
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200 divide-y divide-slate-100">
                {permissions.map((perm) => (
                  <div
                    key={perm.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900">
                          {perm.granteeName ?? perm.granteeId}
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.625rem] font-mono text-slate-600">
                          {perm.granteeType}
                        </span>
                        {perm.inherited && (
                          <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[0.625rem] text-amber-700">
                            継承 ({perm.sourceName ?? '親フォルダ'})
                          </span>
                        )}
                      </div>
                      {perm.granteeEmail && (
                        <div className="text-[0.6875rem] text-slate-600">
                          {perm.granteeEmail}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                        {ROLE_META[perm.role]?.label ?? perm.role}
                      </span>
                      {canManage && !perm.inherited && (
                        <button
                          type="button"
                          onClick={() => handleRevoke(perm)}
                          title="権限を削除"
                          className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
    </ModalShell>
  );
}
