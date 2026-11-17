'use client';

import {
  AlertTriangle,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  ADMIN_CAPABILITY_LABELS,
  ADMIN_CAPABILITY_ORDER,
  ADMIN_DELEGATION_PRESET_IDS,
  SYS_ADMIN_ONLY_OPERATIONS,
  adminDelegationErrorMessage,
  canManageAdminDelegations,
  delegationPresetLabel,
  delegationScopeLabel,
  expandAdminDelegationPreset,
  isDelegatedCoAdmin,
} from '@/lib/admin-delegations';
import {
  createAdminDelegation,
  deleteAdminDelegation,
  fetchAdminDelegations,
  fetchAdminGroups,
  fetchAdminMembers,
  fetchAdminRootFolders,
  updateAdminDelegation,
} from '@/lib/files-api';
import { ApiClientError } from '@/lib/files-api/core';
import type {
  AdminCapability,
  AdminDelegationListResponse,
  AdminDelegationPreset,
  AdminDelegationRow,
  AdminGroupRow,
  AdminMemberRow,
  AdminRootFolderRecord,
  AuthUser,
} from '@/types/files';

interface DelegationFormState {
  userId: string;
  preset: AdminDelegationPreset | '';
  permissions: AdminCapability[];
  scopeGroupId: string;
  scopeRootFolderId: string;
  note: string;
}

const EMPTY_FORM: DelegationFormState = {
  userId: '',
  preset: 'auditor',
  permissions: expandAdminDelegationPreset('auditor'),
  scopeGroupId: '',
  scopeRootFolderId: '',
  note: '',
};

function toFormState(delegation: AdminDelegationRow): DelegationFormState {
  return {
    userId: delegation.userId,
    preset:
      delegation.preset &&
      ADMIN_DELEGATION_PRESET_IDS.includes(
        delegation.preset as AdminDelegationPreset
      )
        ? (delegation.preset as AdminDelegationPreset)
        : '',
    permissions: [...delegation.permissions],
    scopeGroupId: delegation.scopeGroupId ?? '',
    scopeRootFolderId: delegation.scopeRootFolderId ?? '',
    note: delegation.note ?? '',
  };
}

/**
 * P13-1 / TOM-73 sys_admin delegation manager.
 *
 * Mounted from `/admin/users`. Non-sys users never call `/api/admin/delegations`
 * because that endpoint is deliberately sys_admin-only; they see an immutable
 * notice instead of a disabled form that could look like a broken permission.
 */
export function AdminDelegationsSection({ user }: { user: AuthUser | null }) {
  const baseId = useId();
  const canManage = canManageAdminDelegations(user);
  const [data, setData] = useState<AdminDelegationListResponse | null>(null);
  const [members, setMembers] = useState<AdminMemberRow[]>([]);
  const [groups, setGroups] = useState<AdminGroupRow[]>([]);
  const [roots, setRoots] = useState<AdminRootFolderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminDelegationRow | null>(null);
  const [form, setForm] = useState<DelegationFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    setError(null);
    try {
      const delegations = await fetchAdminDelegations();
      setData(delegations);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? adminDelegationErrorMessage(err.code, err.message)
          : '共同管理者委任の読み込みに失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  const loadFormOptions = useCallback(async (force = false) => {
    if (!canManage) return;
    if (optionsLoaded && !force) return;
    setOptionsLoading(true);
    try {
      // Load selector candidates lazily when opening the grant/edit modal so
      // mounting `/admin/users` only hits `GET /api/admin/delegations`. Root
      // folder counts are omitted (`includeMetrics: false`) since only IDs and
      // names are rendered in the dropdown.
      const [memberList, groupList, rootList] = await Promise.all([
        fetchAdminMembers({ role: 'member', status: 'active', limit: 200 }),
        fetchAdminGroups({ limit: 500 }),
        fetchAdminRootFolders({ status: 'active', includeMetrics: false }),
      ]);
      setMembers(memberList.users);
      setGroups(groupList.groups);
      setRoots(rootList.roots);
      setOptionsLoaded(true);
    } catch (err) {
      setFormError(
        err instanceof ApiClientError
          ? adminDelegationErrorMessage(err.code, err.message)
          : '選択候補の読み込みに失敗しました'
      );
    } finally {
      setOptionsLoading(false);
    }
  }, [canManage, optionsLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const delegations = data?.delegations ?? [];
  const capabilityOptions = data?.capabilities ?? [];
  const assignedUserIds = useMemo(
    () => new Set(delegations.map((item) => item.userId)),
    [delegations]
  );
  const selectableMembers = useMemo(
    () =>
      members.filter(
        (member) =>
          member.id === editing?.userId || !assignedUserIds.has(member.id)
      ),
    [assignedUserIds, editing?.userId, members]
  );

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
    void loadFormOptions();
  }

  function openEdit(delegation: AdminDelegationRow) {
    setEditing(delegation);
    setForm(toFormState(delegation));
    setFormError(null);
    setFormOpen(true);
    void loadFormOptions();
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
    setEditing(null);
    setFormError(null);
  }

  function applyPreset(preset: AdminDelegationPreset) {
    setForm((current) => ({
      ...current,
      preset,
      permissions: expandAdminDelegationPreset(preset),
    }));
  }

  function toggleCapability(capability: AdminCapability) {
    setForm((current) => {
      const next = new Set(current.permissions);
      if (next.has(capability)) next.delete(capability);
      else next.add(capability);
      return {
        ...current,
        preset: '',
        permissions: ADMIN_CAPABILITY_ORDER.filter((item) => next.has(item)),
      };
    });
  }

  async function submitForm() {
    if (saving) return;
    if (!editing && !form.userId) {
      setFormError('委任先の一般メンバーを選択してください。');
      return;
    }
    if (form.permissions.length === 0) {
      setFormError('1 つ以上の管理 Capability を選択してください。');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        preset: form.preset || null,
        permissions: form.permissions,
        scopeGroupId: form.scopeGroupId || null,
        scopeRootFolderId: form.scopeRootFolderId || null,
        note: form.note.trim() || null,
      };
      if (editing) {
        await updateAdminDelegation(editing.id, payload);
        setNotice('共同管理者委任を更新しました。');
      } else {
        await createAdminDelegation({ userId: form.userId, ...payload });
        setNotice('共同管理者委任を作成しました。');
      }
      setFormOpen(false);
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError
          ? adminDelegationErrorMessage(err.code, err.message)
          : '共同管理者委任の保存に失敗しました'
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeDelegation(delegation: AdminDelegationRow) {
    if (!window.confirm(`${delegation.userEmail ?? delegation.userId} の共同管理者委任を削除しますか？`)) {
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await deleteAdminDelegation(delegation.id);
      setNotice('共同管理者委任を削除しました。次回リクエストから権限が失効します。');
      await load();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? adminDelegationErrorMessage(err.code, err.message)
          : '共同管理者委任の削除に失敗しました'
      );
    }
  }

  if (!canManage) {
    return (
      <section
        data-testid="admin-delegations-section"
        aria-labelledby={`${baseId}-heading`}
        className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
      >
        <h2
          id={`${baseId}-heading`}
          className="flex items-center gap-2 text-[0.875rem] font-semibold text-[#111214]"
        >
          <Users className="h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
          共同管理者 (Co-Admin) 委任
        </h2>
        <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-900">
          委任の作成・変更・削除は sys_admin 専用です。
          {isDelegatedCoAdmin(user)
            ? ' あなたの権限は sys_admin が付与した内容に固定されています。'
            : ''}
        </p>
      </section>
    );
  }

  return (
    <section
      id="admin-delegations"
      data-testid="admin-delegations-section"
      aria-labelledby={`${baseId}-heading`}
      className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id={`${baseId}-heading`}
            className="flex items-center gap-2 text-[0.875rem] font-semibold text-[#111214]"
          >
            <Users className="h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
            共同管理者 (Co-Admin) 委任
          </h2>
          <p className="mt-1 text-[0.6875rem] text-[#55565a]">
            一般メンバーへ細粒度の管理 Capability とグループ / ルートフォルダのスコープを委任します。ロールは変更されません。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            再読み込み
          </button>
          <button
            type="button"
            data-testid="delegation-create-open"
            onClick={openCreate}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2]"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            委任を追加
          </button>
        </div>
      </header>

      <div
        role="note"
        className="mt-3 rounded-xl border border-[#e1e1e1] bg-[#f7f7f8] px-3 py-2 text-[0.625rem] text-[#55565a]"
      >
        <span className="font-semibold text-[#111214]">
          <ShieldAlert className="mr-1 inline h-3 w-3" aria-hidden="true" />
          Co-Admin に委任できない sys_admin 専用操作:
        </span>{' '}
        {SYS_ADMIN_ONLY_OPERATIONS.join(' / ')}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
        >
          {notice}
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-y-1 text-left text-[0.6875rem]">
          <thead className="text-[0.625rem] uppercase tracking-[0.06em] text-[#55565a]">
            <tr>
              <th scope="col" className="px-2 py-1">メンバー</th>
              <th scope="col" className="px-2 py-1">プリセット</th>
              <th scope="col" className="px-2 py-1">権限</th>
              <th scope="col" className="px-2 py-1">スコープ</th>
              <th scope="col" className="px-2 py-1">付与者</th>
              <th scope="col" className="px-2 py-1">操作</th>
            </tr>
          </thead>
          <tbody>
            {delegations.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-[#55565a]">
                  有効な共同管理者委任はありません。
                </td>
              </tr>
            )}
            {delegations.map((delegation) => (
              <tr
                key={delegation.id}
                data-testid={`delegation-row-${delegation.userId}`}
                className="rounded-lg bg-[#f9f9fa]"
              >
                <td className="rounded-l-lg px-2 py-2">
                  <div className="font-medium text-[#111214]">
                    {delegation.userName ?? delegation.userId}
                  </div>
                  <div className="text-[0.625rem] text-[#55565a]">
                    {delegation.userEmail ?? '—'}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <span className="inline-flex rounded-full border border-[#d9dcf5] bg-[#eef0fc] px-2 py-0.5 text-[0.625rem] font-medium text-[#3f4a9e]">
                    {delegationPresetLabel(delegation.preset)}
                  </span>
                </td>
                <td className="max-w-[22rem] px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    {delegation.permissions.map((capability) => (
                      <span
                        key={capability}
                        title={capability}
                        className="inline-flex rounded border border-[#e1e1e4] bg-white px-1.5 py-0.5 text-[0.5625rem] text-[#3c3f46]"
                      >
                        {ADMIN_CAPABILITY_LABELS[capability] ?? capability}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-2 text-[#3c3f46]">
                  {delegationScopeLabel(delegation)}
                </td>
                <td className="px-2 py-2 text-[#55565a]">
                  {delegation.grantedByName ?? delegation.grantedBy}
                </td>
                <td className="rounded-r-lg px-2 py-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid={`delegation-edit-${delegation.id}`}
                      onClick={() => openEdit(delegation)}
                      className="inline-flex h-6 items-center gap-1 rounded border border-[#e1e1e4] bg-white px-2 text-[0.625rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                    >
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                      編集
                    </button>
                    <button
                      type="button"
                      data-testid={`delegation-delete-${delegation.id}`}
                      onClick={() => void removeDelegation(delegation)}
                      className="inline-flex h-6 items-center gap-1 rounded border border-red-200 bg-red-50 px-2 text-[0.625rem] font-medium text-red-700 transition hover:bg-red-100"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      削除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {formOpen && (
        <ModalShell
          label={editing ? '共同管理者委任を編集' : '共同管理者委任を作成'}
          onClose={closeForm}
          className="w-[min(46rem,calc(100vw-2rem))]"
        >
          <div data-testid="delegation-modal" className="space-y-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[0.9375rem] font-semibold text-[#111214]">
                  {editing ? '共同管理者委任を編集' : '共同管理者委任を作成'}
                </h3>
                <p className="text-[0.6875rem] text-[#55565a]">
                  sys_admin のみが実行できます。委任先のロールは member のままです。
                </p>
              </div>
              <button
                type="button"
                onClick={closeForm}
                disabled={saving}
                className="rounded p-1 text-[#676b72] hover:bg-[#f2f2f4]"
                aria-label="閉じる"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[0.6875rem] font-medium text-[#111214]">
                委任先メンバー
                <select
                  data-testid="delegation-user-select"
                  value={form.userId}
                  disabled={Boolean(editing) || optionsLoading}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      userId: event.target.value,
                    }))
                  }
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] disabled:bg-[#f2f2f4]"
                >
                  <option value="">
                    {optionsLoading ? '選択候補を読み込み中...' : '選択してください'}
                  </option>
                  {selectableMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName} ({member.email})
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[0.6875rem] font-medium text-[#111214]">
                メモ
                <input
                  type="text"
                  value={form.note}
                  maxLength={500}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                  placeholder="例: 2026 Q4 監査対応"
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem]"
                />
              </label>
            </div>

            <div>
              <p className="text-[0.6875rem] font-medium text-[#111214]">
                プリセット（ワンクリック適用）
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {ADMIN_DELEGATION_PRESET_IDS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    data-testid={`delegation-preset-${preset}`}
                    onClick={() => applyPreset(preset)}
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[0.6875rem] font-medium transition ${
                      form.preset === preset
                        ? 'border-[#5e6ad2] bg-[#eef0fc] text-[#3f4a9e]'
                        : 'border-[#e1e1e4] bg-white text-[#3c3f46] hover:bg-[#f2f2f4]'
                    }`}
                  >
                    {form.preset === preset && (
                      <Check className="h-3 w-3" aria-hidden="true" />
                    )}
                    {delegationPresetLabel(preset)}
                  </button>
                ))}
              </div>
            </div>

            <fieldset>
              <legend className="text-[0.6875rem] font-medium text-[#111214]">
                個別 Capability
              </legend>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                {(capabilityOptions.length > 0
                  ? capabilityOptions
                  : ADMIN_CAPABILITY_ORDER.map((id) => ({
                      id,
                      label: ADMIN_CAPABILITY_LABELS[id],
                    }))
                ).map((capability) => (
                  <label
                    key={capability.id}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[0.6875rem] text-[#3c3f46] hover:bg-[#f7f7f8]"
                  >
                    <input
                      type="checkbox"
                      checked={form.permissions.includes(capability.id)}
                      onChange={() => toggleCapability(capability.id)}
                      className="h-3.5 w-3.5"
                    />
                    <span title={capability.id}>{capability.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[0.6875rem] font-medium text-[#111214]">
                グループスコープ
                <select
                  value={form.scopeGroupId}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      scopeGroupId: event.target.value,
                    }))
                  }
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem]"
                >
                  <option value="">テナント全体</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[0.6875rem] font-medium text-[#111214]">
                ルートフォルダスコープ
                <select
                  value={form.scopeRootFolderId}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      scopeRootFolderId: event.target.value,
                    }))
                  }
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem]"
                >
                  <option value="">テナント全体</option>
                  {roots.map((root) => (
                    <option key={root.id} value={root.id}>
                      {root.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeForm}
                disabled={saving}
                className="inline-flex h-7 items-center rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                data-testid="delegation-submit"
                onClick={() => void submitForm()}
                disabled={saving}
                className="inline-flex h-7 items-center rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {saving ? '保存中...' : editing ? '更新' : '作成'}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
