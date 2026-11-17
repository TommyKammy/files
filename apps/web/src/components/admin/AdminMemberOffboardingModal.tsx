'use client';

import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Folder,
  Link2,
  LockKeyhole,
  Loader2,
  MailQuestion,
  ShieldAlert,
  UserMinus,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  OFFBOARDING_CONFIRMATION_TEXT,
  OFFBOARDING_FILE_REQUESTS_LABELS,
  OFFBOARDING_SHARED_LINKS_LABELS,
  OFFBOARDING_USER_ACTION_LABELS,
  canExecuteMemberOffboarding,
  createOffboardingIdempotencyKey,
  filterOffboardingTransferCandidates,
  formatOffboardingResultSummary,
  matchesOffboardingConfirmation,
  offboardingRequiresTransfer,
  summarizeOffboardingActions,
} from '@/lib/admin-offboarding';
import {
  ApiClientError,
  fetchAdminMemberOffboardingPreview,
  offboardAdminMember,
} from '@/lib/files-api';
import type {
  AdminMemberRow,
  AdminOffboardingFileRequestsAction,
  AdminOffboardingPreviewResponse,
  AdminOffboardingResponse,
  AdminOffboardingSharedLinksAction,
  AdminOffboardingUserAction,
  UserRole,
} from '@/types/files';

type WizardStep = 1 | 2 | 3;

function CountCard({
  testId,
  label,
  value,
  tone = 'default',
}: {
  testId: string;
  label: string;
  value: number;
  tone?: 'default' | 'warning';
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-xl border px-3 py-2 ${
        tone === 'warning'
          ? 'border-amber-200 bg-amber-50'
          : 'border-slate-200 bg-slate-50'
      }`}
    >
      <p className="text-[0.625rem] text-slate-500">{label}</p>
      <p className="mt-0.5 text-[1rem] font-semibold text-slate-900">
        {value}
        <span className="ml-0.5 text-[0.625rem] font-normal text-slate-500">
          件
        </span>
      </p>
    </div>
  );
}

export function AdminMemberOffboardingModal({
  member,
  viewerId,
  viewerRole,
  activeSysAdminCount,
  onClose,
  onCompleted,
}: {
  member: AdminMemberRow;
  viewerId: string | null;
  viewerRole: UserRole | null;
  activeSysAdminCount: number;
  onClose: () => void;
  onCompleted: (result: AdminOffboardingResponse) => void;
}) {
  const baseId = useId();
  const [step, setStep] = useState<WizardStep>(1);
  const [preview, setPreview] = useState<AdminOffboardingPreviewResponse | null>(
    null
  );
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [transferToUserId, setTransferToUserId] = useState('');
  const [candidateQuery, setCandidateQuery] = useState('');
  const [sharedLinksAction, setSharedLinksAction] =
    useState<AdminOffboardingSharedLinksAction>('transfer_owner');
  const [fileRequestsAction, setFileRequestsAction] =
    useState<AdminOffboardingFileRequestsAction>('transfer_owner');
  const [userAction, setUserAction] =
    useState<AdminOffboardingUserAction>('suspend');
  const [revokeDirectPermissions, setRevokeDirectPermissions] = useState(true);
  const [removeGroupMemberships, setRemoveGroupMemberships] = useState(true);
  const [releaseHeldLocks, setReleaseHeldLocks] = useState(true);
  const [confirmation, setConfirmation] = useState('');
  const [idempotencyKey] = useState(() =>
    createOffboardingIdempotencyKey(member.id)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminOffboardingResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreview(null);
    setPreviewError(null);
    fetchAdminMemberOffboardingPreview(member.id)
      .then((response) => {
        if (cancelled) return;
        setPreview(response);
        if (response.transferCandidates.length === 1) {
          setTransferToUserId(response.transferCandidates[0]!.id);
        }
        if (response.activeSharedLinks.length === 0) {
          setSharedLinksAction('revoke_all');
        }
        if (response.activeFileRequests.length === 0) {
          setFileRequestsAction('deactivate_all');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(
          err instanceof ApiClientError
            ? err.message
            : 'オフボーディング棚卸しの読み込みに失敗しました'
        );
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [member.id]);

  const candidates = useMemo(
    () =>
      preview
        ? filterOffboardingTransferCandidates(
            preview.transferCandidates,
            candidateQuery
          )
        : [],
    [candidateQuery, preview]
  );

  const requiresTransfer = preview
    ? offboardingRequiresTransfer({
        ownedFolderCount: preview.ownedFolderCount,
        sharedLinksAction,
        fileRequestsAction,
      })
    : false;
  const targetEmail = preview?.user.email ?? member.email;
  const confirmationMatches = matchesOffboardingConfirmation(
    confirmation,
    targetEmail
  );
  const canExecute =
    canExecuteMemberOffboarding(viewerRole) &&
    !busy &&
    preview !== null &&
    (!requiresTransfer || transferToUserId.length > 0) &&
    confirmationMatches;

  function close() {
    if (busy) return;
    onClose();
  }

  async function execute() {
    if (!preview || busy || !canExecute) return;
    setBusy(true);
    setError(null);
    try {
      const response = await offboardAdminMember(
        member.id,
        {
          transferToUserId: transferToUserId || null,
          sharedLinksAction,
          fileRequestsAction,
          userAction,
          revokeDirectPermissions,
          removeGroupMemberships,
          releaseHeldLocks,
          confirmation: confirmation.trim(),
        },
        { idempotencyKey }
      );
      setResult(response);
      setStep(3);
      onCompleted(response);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'オフボーディングの実行に失敗しました'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      label="メンバーの退職/移管 (オフボーディング)"
      labelledBy={`${baseId}-heading`}
      onClose={close}
      className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div
        data-testid="member-offboarding-modal"
        className="flex max-h-[88vh] flex-col"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h3
              id={`${baseId}-heading`}
              className="text-sm font-semibold text-slate-900"
            >
              退職/移管 (オフボーディング)
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              {member.email} — Step {step} / 3
            </p>
          </div>
          <button
            type="button"
            data-testid="offboarding-close"
            aria-label="オフボーディングを閉じる"
            onClick={close}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4 text-xs">
          {step === 1 && (
            <div data-testid="offboarding-step-preview" className="space-y-4">
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-600">
                対象メンバーが所有・作成しているコンテンツを棚卸しします。唯一オーナーのフォルダは、移管先を指定しない限りオフボーディングできません。
              </p>
              {previewLoading && (
                <p className="flex items-center gap-1.5 text-slate-500">
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  棚卸しを読み込み中...
                </p>
              )}
              {previewError && (
                <div
                  role="alert"
                  data-testid="offboarding-preview-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {previewError}
                </div>
              )}
              {preview && (
                <>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <CountCard
                      testId="offboarding-preview-sole-owner"
                      label="唯一オーナー"
                      value={preview.soleOwnerCount}
                      tone={preview.soleOwnerCount > 0 ? 'warning' : 'default'}
                    />
                    <CountCard
                      testId="offboarding-preview-direct-permissions"
                      label="直接権限"
                      value={preview.directPermissions.total}
                    />
                    <CountCard
                      testId="offboarding-preview-shared-links"
                      label="有効共有リンク"
                      value={preview.activeSharedLinks.length}
                    />
                    <CountCard
                      testId="offboarding-preview-file-requests"
                      label="有効ファイル要求"
                      value={preview.activeFileRequests.length}
                    />
                    <CountCard
                      testId="offboarding-preview-locks"
                      label="保持中ロック"
                      value={preview.heldLocks.length}
                    />
                    <CountCard
                      testId="offboarding-preview-sessions"
                      label="有効セッション"
                      value={preview.activeSessionCount}
                    />
                  </div>

                  <div className="grid gap-3 lg:grid-cols-2">
                    <section className="rounded-xl border border-slate-200 p-3">
                      <h4 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                        <Folder className="h-3.5 w-3.5" aria-hidden="true" />
                        所有フォルダ ({preview.ownedFolderCount})
                      </h4>
                      {preview.ownedFolders.length === 0 ? (
                        <p className="text-slate-500">
                          直接所有しているフォルダはありません。
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {preview.ownedFolders.map((folder) => (
                            <li
                              key={folder.id}
                              data-testid="offboarding-owned-folder"
                              className="flex items-center justify-between gap-2 rounded-md border border-slate-100 px-2 py-1"
                            >
                              <span className="truncate text-slate-700">
                                {folder.name}
                              </span>
                              <span
                                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-medium ${
                                  folder.soleOwner
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {folder.soleOwner ? '唯一オーナー' : '共同オーナーあり'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section className="rounded-xl border border-slate-200 p-3">
                      <h4 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                        有効共有リンク
                      </h4>
                      {preview.activeSharedLinks.length === 0 ? (
                        <p className="text-slate-500">有効な共有リンクはありません。</p>
                      ) : (
                        <ul className="space-y-1">
                          {preview.activeSharedLinks.map((link) => (
                            <li
                              key={link.id}
                              data-testid="offboarding-shared-link"
                              className="rounded-md border border-slate-100 px-2 py-1"
                            >
                              <p className="truncate text-slate-700">
                                {link.targetName ?? link.targetId}
                              </p>
                              <p className="text-[0.625rem] text-slate-500">
                                {link.accessScope} / {link.targetType}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section className="rounded-xl border border-slate-200 p-3">
                      <h4 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                        <MailQuestion
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                        有効ファイルリクエスト
                      </h4>
                      {preview.activeFileRequests.length === 0 ? (
                        <p className="text-slate-500">有効なリクエストはありません。</p>
                      ) : (
                        <ul className="space-y-1">
                          {preview.activeFileRequests.map((request) => (
                            <li
                              key={request.id}
                              data-testid="offboarding-file-request"
                              className="rounded-md border border-slate-100 px-2 py-1"
                            >
                              <p className="truncate text-slate-700">
                                {request.title}
                              </p>
                              <p className="text-[0.625rem] text-slate-500">
                                {request.folderName ?? request.folderId} / 提出{' '}
                                {request.submissionCount} 件
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section className="rounded-xl border border-slate-200 p-3">
                      <h4 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                        <LockKeyhole
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                        保持中ロック / 所属グループ
                      </h4>
                      {preview.heldLocks.length === 0 ? (
                        <p className="text-slate-500">
                          対象ユーザーが保持しているロックはありません。
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {preview.heldLocks.map((lock) => (
                            <li
                              key={lock.fileId}
                              data-testid="offboarding-held-lock"
                              className="rounded-md border border-slate-100 px-2 py-1 text-slate-700"
                            >
                              {lock.fileName ?? lock.fileId} ({lock.mode})
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-[0.625rem] text-slate-500">
                        所属グループ: {preview.groupMembershipCount} 件
                      </p>
                    </section>
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      data-testid="offboarding-cancel"
                      onClick={close}
                      className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      キャンセル
                    </button>
                    <button
                      type="button"
                      data-testid="offboarding-next"
                      data-autofocus
                      disabled={previewLoading || Boolean(previewError)}
                      onClick={() => setStep(2)}
                      className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                    >
                      次へ
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 2 && preview && (
            <div data-testid="offboarding-step-actions" className="space-y-3">
              <div
                className={`rounded-lg border px-3 py-2 text-[0.6875rem] ${
                  requiresTransfer
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
              >
                <p className="flex items-center gap-1.5 font-medium">
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  {requiresTransfer
                    ? '移管先のアクティブな社内メンバーを指定してください。'
                    : '移管対象はありません。アカウント処置のみ実行できます。'}
                </p>
                <p className="mt-0.5">
                  唯一オーナー {preview.soleOwnerCount} 件 / 所有フォルダ{' '}
                  {preview.ownedFolderCount} 件
                </p>
              </div>

              {!canExecuteMemberOffboarding(viewerRole) && (
                <p
                  data-testid="offboarding-preview-only"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-900"
                >
                  プレビューのみ表示しています。オフボーディングの実行は
                  sys_admin 専用です。
                </p>
              )}

              <label className="block text-[0.6875rem] font-medium text-slate-700">
                移管先メンバーの絞り込み
                <input
                  type="search"
                  data-testid="offboarding-transfer-filter"
                  value={candidateQuery}
                  onChange={(event) => setCandidateQuery(event.target.value)}
                  placeholder="メール / 表示名"
                  autoComplete="off"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>

              <label className="block text-[0.6875rem] font-medium text-slate-700">
                移管先アクティブメンバー
                <select
                  data-testid="offboarding-transfer-select"
                  data-autofocus
                  value={transferToUserId}
                  onChange={(event) => setTransferToUserId(event.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                >
                  <option value="">
                    {requiresTransfer ? '選択してください' : '移管しない'}
                  </option>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.displayName} ({candidate.email})
                    </option>
                  ))}
                </select>
                {candidates.length === 0 && (
                  <span className="mt-1 block text-[0.625rem] text-amber-800">
                    条件に一致するアクティブメンバーがいません。
                  </span>
                )}
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-[0.6875rem] font-medium text-slate-700">
                  共有リンクの処置
                  <select
                    data-testid="offboarding-shared-links-action"
                    value={sharedLinksAction}
                    onChange={(event) =>
                      setSharedLinksAction(
                        event.target.value as AdminOffboardingSharedLinksAction
                      )
                    }
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                  >
                    <option value="transfer_owner">
                      {OFFBOARDING_SHARED_LINKS_LABELS.transfer_owner}
                    </option>
                    <option value="revoke_all">
                      {OFFBOARDING_SHARED_LINKS_LABELS.revoke_all}
                    </option>
                  </select>
                </label>
                <label className="block text-[0.6875rem] font-medium text-slate-700">
                  ファイルリクエストの処置
                  <select
                    data-testid="offboarding-file-requests-action"
                    value={fileRequestsAction}
                    onChange={(event) =>
                      setFileRequestsAction(
                        event.target.value as AdminOffboardingFileRequestsAction
                      )
                    }
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                  >
                    <option value="transfer_owner">
                      {OFFBOARDING_FILE_REQUESTS_LABELS.transfer_owner}
                    </option>
                    <option value="deactivate_all">
                      {OFFBOARDING_FILE_REQUESTS_LABELS.deactivate_all}
                    </option>
                  </select>
                </label>
                <label className="block text-[0.6875rem] font-medium text-slate-700">
                  アカウントの処置
                  <select
                    data-testid="offboarding-user-action"
                    value={userAction}
                    onChange={(event) =>
                      setUserAction(
                        event.target.value as AdminOffboardingUserAction
                      )
                    }
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                  >
                    <option value="suspend">
                      {OFFBOARDING_USER_ACTION_LABELS.suspend}
                    </option>
                    <option value="keep_status">
                      {OFFBOARDING_USER_ACTION_LABELS.keep_status}
                    </option>
                  </select>
                </label>
                <div className="space-y-1.5 rounded-lg border border-slate-200 p-2 text-[0.625rem] text-slate-700">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      data-testid="offboarding-revoke-permissions"
                      checked={revokeDirectPermissions}
                      onChange={(event) =>
                        setRevokeDirectPermissions(event.target.checked)
                      }
                    />
                    直接権限を剥奪 ({preview.directPermissions.total} 件)
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      data-testid="offboarding-remove-groups"
                      checked={removeGroupMemberships}
                      onChange={(event) =>
                        setRemoveGroupMemberships(event.target.checked)
                      }
                    />
                    グループ所属を解除 ({preview.groupMembershipCount} 件)
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      data-testid="offboarding-release-locks"
                      checked={releaseHeldLocks}
                      onChange={(event) =>
                        setReleaseHeldLocks(event.target.checked)
                      }
                    />
                    保持中ロック/WOPI セッションを解放 (
                    {preview.heldLocks.length} 件)
                  </label>
                </div>
              </div>

              <label className="block text-[0.6875rem] font-medium text-slate-700">
                確認入力（{OFFBOARDING_CONFIRMATION_TEXT} または {targetEmail})
                <input
                  type="text"
                  data-testid="offboarding-confirm-input"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>

              <p className="text-[0.625rem] text-slate-500">
                {summarizeOffboardingActions({
                  sharedLinksAction,
                  fileRequestsAction,
                  userAction,
                })}
              </p>
              <p
                data-testid="offboarding-idempotency-key"
                className="break-all font-mono text-[0.625rem] text-slate-500"
              >
                Idempotency-Key: {idempotencyKey}
              </p>

              {error && (
                <div
                  role="alert"
                  data-testid="offboarding-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {error}
                </div>
              )}

              <div className="flex justify-between gap-2">
                <button
                  type="button"
                  data-testid="offboarding-back"
                  onClick={() => setStep(1)}
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  戻る
                </button>
                <button
                  type="button"
                  data-testid="offboarding-execute"
                  disabled={!canExecute}
                  onClick={() => void execute()}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  オフボーディングを実行
                </button>
              </div>
            </div>
          )}

          {step === 3 && result && (
            <div data-testid="offboarding-step-result" className="space-y-3">
              <div
                data-testid="offboarding-result-summary"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900"
              >
                <p className="flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  オフボーディングが完了しました
                </p>
                <p className="mt-1 text-[0.6875rem]">
                  {formatOffboardingResultSummary(result)}
                </p>
                <p className="mt-0.5 text-[0.625rem]">
                  {result.notice}
                </p>
              </div>
              {result.replayed && (
                <p
                  data-testid="offboarding-result-replayed"
                  className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[0.6875rem] text-blue-800"
                >
                  同じ Idempotency-Key の保存済み結果を再生しました（再実行なし）。
                </p>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[0.625rem] text-slate-500">移管先</p>
                  <p className="font-medium text-slate-900">
                    {result.transferTarget
                      ? `${result.transferTarget.displayName} (${result.transferTarget.email})`
                      : 'なし'}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[0.625rem] text-slate-500">アカウント状態</p>
                  <p
                    data-testid="offboarding-result-status"
                    className="font-medium text-slate-900"
                  >
                    {result.user.status === 'suspended' ? '停止中' : '有効'}
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="offboarding-done"
                  onClick={close}
                  className="inline-flex h-8 items-center rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2]"
                >
                  閉じる
                </button>
              </div>
            </div>
          )}

          {step === 2 && !preview && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
            >
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              棚卸し結果がありません。いったん閉じて再試行してください。
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
