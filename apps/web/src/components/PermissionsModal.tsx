'use client';

import { Loader2, Search, Shield, Trash2, UserPlus, Users } from 'lucide-react';
import { useMemo } from 'react';
import { ModalShell } from '@/components/ModalShell';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import {
  CAPABILITY_CHIPS,
  ROLE_CAPABILITY_CHIPS,
  ROLE_META,
  canAccess,
  formatRoleBreakdown,
  roleGroupsForTarget,
  synthesizeEffectiveAccessFromRoles,
} from '@/lib/capabilities';
import { usePermissionsModal } from '@/lib/use-permissions-modal';
import type {
  Capability,
  PermissionEntry,
  ResourceRole,
} from '@/types/files';

const FILE_ROLE_NOTE =
  '投稿系ロール (Uploader / Previewer + Uploader / Viewer + Uploader) はフォルダ専用です。ファイルには Owner / Co-Owner / Editor / Viewer / Previewer のみ付与できます。';

function CapabilityChips({
  capabilityLabels,
  max,
  ariaLabel,
}: {
  capabilityLabels: string[];
  max?: number;
  ariaLabel: string;
}) {
  const shown =
    max !== undefined ? capabilityLabels.slice(0, max) : capabilityLabels;
  const hidden = capabilityLabels.length - shown.length;
  return (
    <ul
      aria-label={ariaLabel}
      className="flex flex-wrap gap-1"
    >
      {shown.map((label) => (
        <li
          key={label}
          className="rounded-full border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[0.625rem] leading-4 text-blue-700"
        >
          {label}
        </li>
      ))}
      {hidden > 0 && (
        <li className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[0.625rem] leading-4 text-slate-600">
          +{hidden}
        </li>
      )}
    </ul>
  );
}

function capabilityLabels(capabilities: Capability[]): string[] {
  return capabilities.map((capability) => CAPABILITY_CHIPS[capability]);
}

function grantLabel(
  entry: Pick<PermissionEntry, 'role' | 'inherited' | 'sourceName'>,
  targetType: 'folder' | 'file'
): string {
  const source = entry.inherited
    ? `親フォルダ (${entry.sourceName ?? '親フォルダ'})`
    : targetType === 'folder'
      ? 'このフォルダ'
      : 'このファイル';
  return `${source} の ${ROLE_META[entry.role]?.label ?? entry.role}`;
}

export function PermissionsModal({
  targetType,
  targetId,
  targetName,
  effectiveRole,
  targetCapabilities,
  onClose,
}: {
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  effectiveRole: ResourceRole;
  targetCapabilities?: Capability[];
  onClose: () => void;
}) {
  const {
    permissions,
    capabilities,
    advancedRolesEnabled,
    permissionInheritanceMode,
    effectiveBreakdown,
    effectiveRole: currentEffectiveRole,
    loading,
    error,
    query,
    setQuery,
    candidates,
    setCandidates,
    searching,
    selectedPrincipal,
    setSelectedPrincipal,
    selectedPrincipalLock,
    role,
    setRole,
    submitting,
    canManage,
    handleGrant,
    handleRevoke,
  } = usePermissionsModal({ targetType, targetId, effectiveRole });

  const effectiveCapabilities = targetCapabilities ?? capabilities;
  const canViewPermissions = canAccess(
    { capabilities: effectiveCapabilities, effectiveRole: currentEffectiveRole },
    'permission.view'
  );

  const roleGroups = useMemo(
    () =>
      roleGroupsForTarget(targetType, {
        advancedRolesEnabled,
      }).map((group) => ({
        ...group,
        roles: group.roles.filter(
          (candidate) => candidate !== 'owner' || currentEffectiveRole === 'owner'
        ),
      })),
    [targetType, advancedRolesEnabled, currentEffectiveRole]
  );

  const assignableRoleIds = roleGroups.flatMap((group) => group.roles);
  const selectedRoleDescription =
    role && assignableRoleIds.includes(role)
      ? ROLE_META[role]
      : ROLE_META[assignableRoleIds[0] ?? 'viewer'];

  // Keep the selected role legal when the advanced policy changes underneath us.
  const safeRole = assignableRoleIds.includes(role)
    ? role
    : assignableRoleIds[0] ?? 'viewer';

  const requesterBreakdown = useMemo(() => {
    if (effectiveBreakdown.length === 0) return null;
    const ordered = [...effectiveBreakdown].sort(
      (a, b) => Number(b.inherited) - Number(a.inherited)
    );
    return {
      roles: ordered.map((grant) => grant.role),
      label: ordered
        .map((grant) =>
          grant.inherited
            ? `親フォルダ (${grant.sourceName ?? '親フォルダ'}) の ${
                ROLE_META[grant.role]?.label ?? grant.role
              }`
            : `この${targetType === 'folder' ? 'フォルダ' : 'ファイル'} の ${
                ROLE_META[grant.role]?.label ?? grant.role
              }`
        )
        .join(' + '),
      capabilities: synthesizeEffectiveAccessFromRoles(
        ordered.map((grant) => grant.role)
      ).capabilities,
    };
  }, [effectiveBreakdown, targetType]);

  const granteeBreakdowns = useMemo(() => {
    const groups = new Map<string, PermissionEntry[]>();
    for (const entry of permissions) {
      const key = `${entry.granteeType}:${entry.granteeId}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    const rows: Array<{
      key: string;
      name: string;
      label: string;
      roles: ResourceRole[];
      capabilities: Capability[];
      inheritedCount: number;
      directCount: number;
    }> = [];
    for (const [key, entries] of groups) {
      const inheritedCount = entries.filter((entry) => entry.inherited).length;
      const directCount = entries.length - inheritedCount;
      if (entries.length < 2) continue;
      // Inherited grants first: matches the documented breakdown example
      // (`親フォルダ の Viewer + このフォルダ の Uploader ＝ Viewer + Uploader`).
      const ordered = [...entries].sort(
        (a, b) => Number(b.inherited) - Number(a.inherited)
      );
      const roles = ordered.map((entry) => entry.role);
      rows.push({
        key,
        name: ordered[0].granteeName ?? ordered[0].granteeId,
        label: ordered
          .map((entry) => grantLabel(entry, targetType))
          .join(' + '),
        roles,
        capabilities: synthesizeEffectiveAccessFromRoles(roles).capabilities,
        inheritedCount,
        directCount,
      });
    }
    return rows;
  }, [permissions, targetType]);

  const showBreakdown =
    Boolean(requesterBreakdown) || granteeBreakdowns.length > 0;

  return (
    <ModalShell
      label={`アクセス権限: ${targetName}`}
      onClose={onClose}
      className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <ModalHeader
        icon={<Shield className="h-4 w-4 shrink-0 text-blue-600" />}
        title={`アクセス権限: ${targetName}`}
        subtitle={`あなたの実効ロール: ${ROLE_META[currentEffectiveRole]?.label ?? currentEffectiveRole}`}
        onClose={onClose}
      />

      <div className="max-h-[75vh] space-y-5 overflow-y-auto p-5">
        <ModalError message={error} />

        <div
          data-testid="permission-inheritance-mode"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium ${
            permissionInheritanceMode === 'waterfall'
              ? 'border-sky-200 bg-sky-50 text-sky-800'
              : 'border-slate-200 bg-slate-50 text-slate-700'
          }`}
        >
          <Shield className="h-3.5 w-3.5" />
          継承:{' '}
          {permissionInheritanceMode === 'waterfall'
            ? 'Waterfall (親優先)'
            : 'Additive (加算)'}
        </div>

        {canManage &&
          permissionInheritanceMode === 'waterfall' &&
          selectedPrincipalLock && (
            <div
              role="alert"
              aria-live="assertive"
              data-testid="waterfall-inherited-notice"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-900"
            >
              親フォルダ「{selectedPrincipalLock.sourceName}」から権限継承中のため、この子フォルダで再付与・変更はできません。親フォルダで変更してください。
            </div>
          )}

        {!canViewPermissions ? (
          <div
            role="status"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs text-amber-800"
          >
            このリソースの権限一覧を表示する権限がありません。
          </div>
        ) : (
          <>
            {canManage && (
              <form
                onSubmit={handleGrant}
                className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
                aria-describedby="permission-role-description"
              >
                <fieldset className="space-y-3">
                  <legend className="text-xs font-semibold text-slate-700">
                    ユーザーまたは SCIM グループを追加
                  </legend>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="relative flex-1">
                      <label
                        htmlFor="permission-principal-search"
                        className="sr-only"
                      >
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

                      {!selectedPrincipal &&
                        (searching || candidates.length > 0) && (
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
                        disabled={Boolean(selectedPrincipalLock)}
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
                        Boolean(selectedPrincipalLock)
                      }
                      title={
                        selectedPrincipalLock
                          ? `親フォルダ「${selectedPrincipalLock.sourceName}」で変更してください`
                          : undefined
                      }
                      className="inline-flex items-center justify-center gap-1.5 self-end rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:mb-0"
                    >
                      {submitting && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      <span>付与</span>
                    </button>
                  </div>

                  <div
                    id="permission-role-description"
                    aria-live="polite"
                    className="space-y-1.5 rounded-lg border border-slate-200 bg-white p-2.5"
                  >
                    <p className="text-[0.6875rem] text-slate-700">
                      <span className="font-semibold">
                        {ROLE_META[safeRole].label}
                      </span>
                      : {ROLE_META[safeRole].description}
                    </p>
                    <CapabilityChips
                      capabilityLabels={ROLE_CAPABILITY_CHIPS[safeRole]}
                      ariaLabel={`${ROLE_META[safeRole].label} の権限`}
                    />
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
            )}

            {showBreakdown && (
              <section
                aria-labelledby="permission-breakdown-heading"
                className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4"
              >
                <h3
                  id="permission-breakdown-heading"
                  className="text-xs font-semibold text-indigo-900"
                >
                  実効権限の内訳
                </h3>

                {requesterBreakdown && (
                  <div className="space-y-1.5" data-testid="permission-breakdown-self">
                    <p className="text-[0.6875rem] font-semibold text-indigo-800">
                      あなたの実効権限
                    </p>
                    <p className="break-words text-[0.6875rem] leading-relaxed text-indigo-900">
                      {requesterBreakdown.label} ＝{' '}
                      <span className="font-semibold">
                        {formatRoleBreakdown(requesterBreakdown.roles)}
                      </span>
                    </p>
                    <CapabilityChips
                      capabilityLabels={capabilityLabels(
                        requesterBreakdown.capabilities
                      )}
                      ariaLabel="あなたの合成権限"
                    />
                  </div>
                )}

                {granteeBreakdowns.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[0.6875rem] font-semibold text-indigo-800">
                      共同作業者の合成権限
                    </p>
                    {granteeBreakdowns.map((row) => (
                      <div
                        key={row.key}
                        data-testid="permission-breakdown-grantee"
                        className="space-y-1.5 rounded-lg border border-indigo-100 bg-white/80 p-2.5"
                      >
                        <p className="text-[0.6875rem] font-medium text-slate-800">
                          {row.name}
                        </p>
                        <p className="break-words text-[0.6875rem] leading-relaxed text-slate-700">
                          {row.label} ＝{' '}
                          <span className="font-semibold text-indigo-800">
                            {formatRoleBreakdown(row.roles)}
                          </span>
                        </p>
                        <p className="text-[0.625rem] text-slate-500">
                          直接 {row.directCount} 件 / 継承 {row.inheritedCount} 件
                        </p>
                        <CapabilityChips
                          capabilityLabels={capabilityLabels(row.capabilities)}
                          ariaLabel={`${row.name} の合成権限`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
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
                <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
                  {permissions.map((perm) => (
                    <div
                      key={perm.id}
                      data-testid={
                        perm.inherited
                          ? 'permission-row-inherited'
                          : 'permission-row-direct'
                      }
                      className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-900">
                            {perm.granteeName ?? perm.granteeId}
                          </span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-600">
                            {perm.granteeType}
                          </span>
                          {perm.inherited && (
                            <span
                              data-testid="permission-inherited-badge"
                              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.625rem] text-amber-700"
                            >
                              継承元: {perm.sourceName ?? '親フォルダ'}
                            </span>
                          )}
                          {perm.inherited && (
                            <span
                              data-testid="permission-inherited-guidance"
                              className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[0.625rem] text-sky-800"
                            >
                              親フォルダ「{perm.sourceName ?? '親フォルダ'}」で変更
                            </span>
                          )}
                          {!perm.inherited &&
                            perm.waterfallLocked &&
                            permissionInheritanceMode === 'waterfall' && (
                              <span
                                data-testid="permission-waterfall-locked-guidance"
                                className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.625rem] text-amber-800"
                              >
                                親フォルダ「
                                {perm.ancestorFolderName ??
                                  perm.sourceName ??
                                  '親フォルダ'}
                                」で変更
                              </span>
                            )}
                        </div>
                        {perm.granteeEmail && (
                          <div className="text-[0.6875rem] text-slate-600">
                            {perm.granteeEmail}
                          </div>
                        )}
                        <div className="mt-1.5">
                          <CapabilityChips
                            capabilityLabels={
                              ROLE_CAPABILITY_CHIPS[perm.role] ?? []
                            }
                            max={5}
                            ariaLabel={`${perm.granteeName ?? perm.granteeId} の権限`}
                          />
                        </div>
                        {perm.synthesizedRole &&
                          perm.synthesizedRole !== perm.role && (
                            <p className="mt-1 text-[0.625rem] text-indigo-700">
                              合成実効ロール:{' '}
                              {ROLE_META[perm.synthesizedRole]?.label ??
                                perm.synthesizedRole}
                            </p>
                          )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                          {ROLE_META[perm.role]?.label ?? perm.role}
                        </span>
                        {canManage && !perm.inherited && (
                          <button
                            type="button"
                            onClick={() => handleRevoke(perm)}
                            title="権限を削除"
                            aria-label={`${perm.granteeName ?? perm.granteeId} の権限を削除`}
                            className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
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
          </>
        )}
      </div>
    </ModalShell>
  );
}
