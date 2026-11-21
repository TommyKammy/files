'use client';

import {
  AlertTriangle,
  Archive,
  Loader2,
  Plus,
  Scale,
  ShieldAlert,
  Trash2,
  Unlock,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiClientError } from '@/lib/files-api/core';
import {
  createAdminLegalHold,
  createAdminRetentionPolicy,
  deleteAdminRetentionPolicy,
  fetchAdminLegalHolds,
  fetchAdminRetentionPolicies,
  releaseAdminLegalHold,
  updateAdminRetentionPolicy,
  type LegalHoldRecord,
  type LegalHoldTargetType,
  type RetentionPolicyRecord,
  type RetentionTargetType,
} from '@/lib/files-api/legal-holds';

const HOLD_TARGET_LABELS: Record<LegalHoldTargetType, string> = {
  folder: 'フォルダ',
  file: 'ファイル',
  user: 'ユーザー',
};

const RETENTION_TARGET_LABELS: Record<RetentionTargetType, string> = {
  folder: 'フォルダ',
  classification: '機密区分',
};

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    return err.code ? `${err.message} (${err.code})` : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function AdminLegalHoldsSection({
  canManage,
}: {
  canManage: boolean;
}) {
  const [holds, setHolds] = useState<LegalHoldRecord[]>([]);
  const [policies, setPolicies] = useState<RetentionPolicyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Legal hold creation form
  const [holdName, setHoldName] = useState('');
  const [holdTargetType, setHoldTargetType] =
    useState<LegalHoldTargetType>('folder');
  const [holdTargetId, setHoldTargetId] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const [creatingHold, setCreatingHold] = useState(false);
  const [releasingId, setReleasingId] = useState<string | null>(null);

  // Retention policy creation form
  const [policyName, setPolicyName] = useState('');
  const [policyTargetType, setPolicyTargetType] =
    useState<RetentionTargetType>('classification');
  const [policyTargetValue, setPolicyTargetValue] = useState('confidential');
  const [policyDays, setPolicyDays] = useState('365');
  const [creatingPolicy, setCreatingPolicy] = useState(false);
  const [busyPolicyId, setBusyPolicyId] = useState<string | null>(null);

  async function reloadAll() {
    setLoading(true);
    try {
      const [holdsRes, policiesRes] = await Promise.all([
        fetchAdminLegalHolds('all'),
        fetchAdminRetentionPolicies(),
      ]);
      setHolds(holdsRes.legalHolds);
      setPolicies(policiesRes.retentionPolicies);
      setError(null);
    } catch (err) {
      setError(
        errorText(err, '法的保持・保持ポリシーの読み込みに失敗しました')
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reloadAll();
  }, []);

  async function handleCreateHold(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || creatingHold) return;
    setCreatingHold(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createAdminLegalHold({
        name: holdName.trim(),
        targetType: holdTargetType,
        targetId: holdTargetId.trim(),
        reason: holdReason.trim() || null,
      });
      setHolds((prev) => [res.legalHold, ...prev]);
      setHoldName('');
      setHoldTargetId('');
      setHoldReason('');
      setNotice(`法的保持「${res.legalHold.name}」を作成しました`);
    } catch (err) {
      setError(errorText(err, '法的保持の作成に失敗しました'));
    } finally {
      setCreatingHold(false);
    }
  }

  async function handleReleaseHold(hold: LegalHoldRecord) {
    if (!canManage || releasingId || hold.status === 'released') return;
    setReleasingId(hold.id);
    setError(null);
    setNotice(null);
    try {
      const res = await releaseAdminLegalHold(hold.id);
      setHolds((prev) =>
        prev.map((item) => (item.id === hold.id ? res.legalHold : item))
      );
      setNotice(`法的保持「${hold.name}」を解除しました`);
    } catch (err) {
      setError(errorText(err, '法的保持の解除に失敗しました'));
    } finally {
      setReleasingId(null);
    }
  }

  async function handleCreatePolicy(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || creatingPolicy) return;
    const days = Number.parseInt(policyDays, 10);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      setError('保持日数は 1〜3650 の整数で指定してください');
      return;
    }
    setCreatingPolicy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createAdminRetentionPolicy({
        name: policyName.trim(),
        targetType: policyTargetType,
        targetValue: policyTargetValue.trim(),
        retentionDays: days,
        enabled: true,
      });
      setPolicies((prev) => [res.retentionPolicy, ...prev]);
      setPolicyName('');
      if (policyTargetType === 'folder') {
        setPolicyTargetValue('');
      }
      setNotice(`保持ポリシー「${res.retentionPolicy.name}」を作成しました`);
    } catch (err) {
      setError(errorText(err, '保持ポリシーの作成に失敗しました'));
    } finally {
      setCreatingPolicy(false);
    }
  }

  async function handleTogglePolicy(policy: RetentionPolicyRecord) {
    if (!canManage || busyPolicyId) return;
    setBusyPolicyId(policy.id);
    setError(null);
    setNotice(null);
    try {
      const res = await updateAdminRetentionPolicy(policy.id, {
        enabled: !policy.enabled,
      });
      setPolicies((prev) =>
        prev.map((item) =>
          item.id === policy.id ? res.retentionPolicy : item
        )
      );
      setNotice(
        `保持ポリシー「${policy.name}」を${res.retentionPolicy.enabled ? '有効化' : '無効化'}しました`
      );
    } catch (err) {
      setError(errorText(err, '保持ポリシーの更新に失敗しました'));
    } finally {
      setBusyPolicyId(null);
    }
  }

  async function handleDeletePolicy(policy: RetentionPolicyRecord) {
    if (!canManage || busyPolicyId) return;
    setBusyPolicyId(policy.id);
    setError(null);
    setNotice(null);
    try {
      await deleteAdminRetentionPolicy(policy.id);
      setPolicies((prev) => prev.filter((item) => item.id !== policy.id));
      setNotice(`保持ポリシー「${policy.name}」を削除しました`);
    } catch (err) {
      setError(errorText(err, '保持ポリシーの削除に失敗しました'));
    } finally {
      setBusyPolicyId(null);
    }
  }

  return (
    <section
      data-testid="admin-legal-holds-section"
      className="space-y-6 rounded-xl border border-[#ececef] bg-white p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-[0.875rem] font-semibold text-slate-900">
            <ShieldAlert className="h-4 w-4 text-[#5e6ad2]" />
            法的保持 (Legal Hold) と保持ポリシー
          </h3>
          <p className="mt-1 text-[0.75rem] text-[#6b6f76]">
            訴訟・監査対応のための法的保持、および機密区分・フォルダ単位の最小保持期間を管理します。対象アイテムはゴミ箱からの完全削除・自動削除から保護されます。
          </p>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          data-testid="admin-legal-holds-error"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.75rem] text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          data-testid="admin-legal-holds-notice"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.75rem] font-medium text-emerald-800"
        >
          {notice}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-[0.75rem] text-[#6b6f76]">
          <Loader2 className="h-4 w-4 animate-spin" />
          読み込み中...
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* Legal Holds */}
          <div className="space-y-4 rounded-xl border border-[#ececef] p-4">
            <h4 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-slate-800">
              <Scale className="h-3.5 w-3.5 text-[#5e6ad2]" />
              法的保持 (Legal Holds)
            </h4>

            <form onSubmit={handleCreateHold} className="space-y-2.5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  placeholder="保持名 (例: 2026年監査対応)"
                  value={holdName}
                  disabled={!canManage}
                  onChange={(e) => setHoldName(e.target.value)}
                  data-testid="legal-hold-name-input"
                  className="h-8 rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
                <select
                  value={holdTargetType}
                  disabled={!canManage}
                  onChange={(e) =>
                    setHoldTargetType(e.target.value as LegalHoldTargetType)
                  }
                  data-testid="legal-hold-target-type"
                  className="h-8 rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem]"
                >
                  <option value="folder">フォルダ</option>
                  <option value="file">ファイル</option>
                  <option value="user">ユーザー</option>
                </select>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  placeholder="対象 ID (folderId / fileId / userId)"
                  value={holdTargetId}
                  disabled={!canManage}
                  onChange={(e) => setHoldTargetId(e.target.value)}
                  data-testid="legal-hold-target-id-input"
                  className="h-8 rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
                <input
                  type="text"
                  placeholder="理由 (任意)"
                  value={holdReason}
                  disabled={!canManage}
                  onChange={(e) => setHoldReason(e.target.value)}
                  data-testid="legal-hold-reason-input"
                  className="h-8 rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </div>
              <button
                type="submit"
                disabled={!canManage || creatingHold}
                data-testid="legal-hold-create-btn"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {creatingHold ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                法的保持を追加
              </button>
            </form>

            <div className="space-y-2">
              {holds.length === 0 ? (
                <p className="text-[0.75rem] text-[#6b6f76]">
                  登録されている法的保持はありません。
                </p>
              ) : (
                holds.map((hold) => (
                  <div
                    key={hold.id}
                    data-testid={`legal-hold-row-${hold.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[#ececef] px-3 py-2 text-[0.75rem]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-slate-900">
                          {hold.name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                            hold.status === 'active'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {hold.status === 'active' ? '有効' : '解除済み'}
                        </span>
                      </div>
                      <p className="truncate text-[0.6875rem] text-[#6b6f76]">
                        {HOLD_TARGET_LABELS[hold.targetType]}: {hold.targetId}
                        {hold.reason ? ` / ${hold.reason}` : ''}
                      </p>
                    </div>
                    {hold.status === 'active' && (
                      <button
                        type="button"
                        disabled={!canManage || releasingId === hold.id}
                        onClick={() => void handleReleaseHold(hold)}
                        data-testid={`legal-hold-release-${hold.id}`}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[#d7d7dc] px-2 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {releasingId === hold.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Unlock className="h-3 w-3" />
                        )}
                        解除
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Retention Policies */}
          <div className="space-y-4 rounded-xl border border-[#ececef] p-4">
            <h4 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-slate-800">
              <Archive className="h-3.5 w-3.5 text-[#5e6ad2]" />
              保持ポリシー (Retention Policies)
            </h4>

            <form onSubmit={handleCreatePolicy} className="space-y-2.5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  placeholder="ポリシー名 (例: 機密文書1年保持)"
                  value={policyName}
                  disabled={!canManage}
                  onChange={(e) => setPolicyName(e.target.value)}
                  data-testid="retention-policy-name-input"
                  className="h-8 rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
                <select
                  value={policyTargetType}
                  disabled={!canManage}
                  onChange={(e) => {
                    const next = e.target.value as RetentionTargetType;
                    setPolicyTargetType(next);
                    setPolicyTargetValue(
                      next === 'classification' ? 'confidential' : ''
                    );
                  }}
                  data-testid="retention-policy-target-type"
                  className="h-8 rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem]"
                >
                  <option value="classification">機密区分</option>
                  <option value="folder">フォルダ</option>
                </select>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {policyTargetType === 'classification' ? (
                  <select
                    value={policyTargetValue}
                    disabled={!canManage}
                    onChange={(e) => setPolicyTargetValue(e.target.value)}
                    data-testid="retention-policy-target-value"
                    className="h-8 rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem]"
                  >
                    <option value="public">public (公開)</option>
                    <option value="internal">internal (社内)</option>
                    <option value="confidential">confidential (機密)</option>
                    <option value="restricted">restricted (極秘)</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    required
                    placeholder="対象フォルダ ID"
                    value={policyTargetValue}
                    disabled={!canManage}
                    onChange={(e) => setPolicyTargetValue(e.target.value)}
                    data-testid="retention-policy-target-value"
                    className="h-8 rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                  />
                )}
                <input
                  type="number"
                  min={1}
                  max={3650}
                  required
                  placeholder="保持日数 (1-3650)"
                  value={policyDays}
                  disabled={!canManage}
                  onChange={(e) => setPolicyDays(e.target.value)}
                  data-testid="retention-policy-days-input"
                  className="h-8 rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </div>
              <button
                type="submit"
                disabled={!canManage || creatingPolicy}
                data-testid="retention-policy-create-btn"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {creatingPolicy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                保持ポリシーを追加
              </button>
            </form>

            <div className="space-y-2">
              {policies.length === 0 ? (
                <p className="text-[0.75rem] text-[#6b6f76]">
                  登録されている保持ポリシーはありません。
                </p>
              ) : (
                policies.map((policy) => (
                  <div
                    key={policy.id}
                    data-testid={`retention-policy-row-${policy.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[#ececef] px-3 py-2 text-[0.75rem]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-slate-900">
                          {policy.name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                            policy.enabled
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {policy.enabled ? '有効' : '無効'}
                        </span>
                      </div>
                      <p className="truncate text-[0.6875rem] text-[#6b6f76]">
                        {RETENTION_TARGET_LABELS[policy.targetType]}:{' '}
                        {policy.targetValue} / {policy.retentionDays}日
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!canManage || busyPolicyId === policy.id}
                        onClick={() => void handleTogglePolicy(policy)}
                        data-testid={`retention-policy-toggle-${policy.id}`}
                        className="inline-flex h-7 items-center rounded-md border border-[#d7d7dc] px-2 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {policy.enabled ? '無効化' : '有効化'}
                      </button>
                      <button
                        type="button"
                        disabled={!canManage || busyPolicyId === policy.id}
                        onClick={() => void handleDeletePolicy(policy)}
                        data-testid={`retention-policy-delete-${policy.id}`}
                        className="inline-flex h-7 items-center rounded-md border border-red-200 px-2 text-[0.6875rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        aria-label={`${policy.name} を削除`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
