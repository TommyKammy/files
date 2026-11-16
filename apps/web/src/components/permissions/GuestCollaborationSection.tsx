'use client';

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Mail,
  RotateCcw,
  Send,
  UserPlus,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  ApiClientError,
  createGuestInvitation,
  resendGuestInvitation,
  revokeGuestInvitation,
} from '@/lib/files-api';
import { ROLE_META } from '@/lib/capabilities';
import {
  GUEST_POLICY_DISABLED_NOTICE,
  GUEST_SHARED_LINK_NOTE,
  buildGuestMailPreviewDraft,
  formatGuestMailPreview,
  guestAssignableRoleOptions,
  guestDomainGuidance,
  guestInvitationStatusLabel,
} from '@/lib/guest-collaboration';
import { formatDateTime } from '@/lib/formatters';
import type {
  GuestInvitationSummary,
  GuestPolicyProjection,
  ResourceRole,
} from '@/types/files';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ConfirmAction = {
  kind: 'resend' | 'revoke';
  invitationId: string;
} | null;

function invitationActionError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.message) return err.message;
  return fallback;
}

export function GuestCollaborationSection({
  targetType,
  targetId,
  targetName,
  canInvite,
  advancedRolesEnabled,
  grantableRoles,
  guestPolicy,
  guestInvitations,
  onReload,
  onOpenGuestDetail,
}: {
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  canInvite: boolean;
  advancedRolesEnabled: boolean;
  grantableRoles: ResourceRole[];
  guestPolicy: GuestPolicyProjection | null;
  guestInvitations: GuestInvitationSummary[];
  onReload: () => Promise<void>;
  onOpenGuestDetail: (userId: string) => void;
}) {
  const policyEnabled = guestPolicy?.allowExternalCollaborators === true;
  const roleOptions = useMemo(
    () =>
      guestAssignableRoleOptions({
        targetType,
        advancedRolesEnabled,
        allowGuestElevatedRoles: guestPolicy?.allowGuestElevatedRoles ?? false,
        grantableRoles,
      }),
    [targetType, advancedRolesEnabled, guestPolicy?.allowGuestElevatedRoles, grantableRoles]
  );

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [externalOrg, setExternalOrg] = useState('');
  const [role, setRole] = useState<ResourceRole>(
    roleOptions[0]?.role ?? 'viewer'
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const safeRole = roleOptions.some((option) => option.role === role)
    ? role
    : roleOptions[0]?.role ?? 'viewer';
  const expiryDays = guestPolicy?.guestInvitationExpiryDays ?? 14;
  const previewExpiresAt = useMemo(
    () =>
      new Date(Date.now() + expiryDays * 24 * 3600 * 1000).toISOString(),
    [expiryDays]
  );
  const mailPreview = useMemo(
    () =>
      formatGuestMailPreview(
        buildGuestMailPreviewDraft({
          displayName: displayName || 'ご担当者',
          externalOrg,
          targetType,
          targetName,
          role: safeRole,
          expiresAt: previewExpiresAt,
        })
      ),
    [
      displayName,
      externalOrg,
      targetType,
      targetName,
      safeRole,
      previewExpiresAt,
    ]
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || !policyEnabled || !canInvite || roleOptions.length === 0) {
      return;
    }
    setError(null);
    setNotice(null);
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      setError('有効なメールアドレスを入力してください。');
      return;
    }
    setSubmitting(true);
    try {
      const response = await createGuestInvitation({
        email: normalizedEmail,
        displayName: displayName.trim() || undefined,
        externalOrg: externalOrg.trim() || null,
        targetType,
        targetId,
        role: safeRole,
      });
      setNotice(
        response.notice ??
          `外部ゲスト「${displayName.trim() || normalizedEmail}」へ招待メールを送信しました。`
      );
      setEmail('');
      setDisplayName('');
      setExternalOrg('');
      setPreviewOpen(false);
      setConfirmAction(null);
      await onReload();
    } catch (err) {
      setError(
        invitationActionError(err, '外部ゲスト招待の作成に失敗しました。')
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function runInvitationAction(
    invitation: GuestInvitationSummary,
    kind: 'resend' | 'revoke'
  ) {
    setBusyInvitationId(invitation.id);
    setError(null);
    setNotice(null);
    try {
      const response =
        kind === 'resend'
          ? await resendGuestInvitation(invitation.id)
          : await revokeGuestInvitation(invitation.id);
      setNotice(
        response.notice ??
          (kind === 'resend'
            ? '招待メールを再送しました。'
            : '招待を取り消し、ゲストの有効セッションを失効させました。')
      );
      setConfirmAction(null);
      await onReload();
    } catch (err) {
      setError(
        invitationActionError(
          err,
          kind === 'resend'
            ? '招待メールの再送に失敗しました。'
            : '招待の取消に失敗しました。'
        )
      );
    } finally {
      setBusyInvitationId(null);
    }
  }

  const disabledReasonNotes = useMemo(() => {
    const notes: string[] = [];
    notes.push('Owner / Co-Owner はゲストに付与できません。');
    if (!guestPolicy?.allowGuestElevatedRoles) {
      notes.push(
        'Editor は既定のゲストポリシーでは選択できません（管理者が高権限ロールを許可した場合のみ）。'
      );
    }
    if (targetType === 'file') {
      notes.push(
        'Uploader / Previewer + Uploader / Viewer + Uploader はフォルダ専用のため、ファイルでは選択できません。'
      );
    }
    return notes;
  }, [guestPolicy?.allowGuestElevatedRoles, targetType]);

  return (
    <section
      aria-labelledby="guest-collaboration-heading"
      data-testid="guest-collaboration-section"
      className="min-w-0 space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="guest-collaboration-heading"
            className="flex items-center gap-1.5 text-xs font-semibold text-amber-950"
          >
            <UserPlus className="h-3.5 w-3.5 shrink-0" />
            外部ゲストを招待
          </h3>
          <p className="mt-0.5 break-words text-[0.6875rem] leading-relaxed text-amber-900">
            社外のコラボレーターをメール招待します。サインインは 6 桁の認証コードで行います。
          </p>
        </div>
        {policyEnabled && (
          <span
            className="inline-flex shrink-0 items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.625rem] font-medium text-emerald-800"
            data-testid="guest-collaboration-enabled-badge"
          >
            外部コラボレーター有効
          </span>
        )}
      </header>

      {!policyEnabled ? (
        <p
          role="note"
          data-testid="guest-collaboration-policy-disabled"
          className="break-words rounded-lg border border-amber-300 bg-white px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900"
        >
          {GUEST_POLICY_DISABLED_NOTICE}
        </p>
      ) : !canInvite ? (
        <p
          role="note"
          className="break-words rounded-lg border border-amber-300 bg-white px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900"
        >
          現在の招待ポリシーではあなたに外部ゲストを招待する権限がありません。所有者または管理者に依頼してください。
        </p>
      ) : roleOptions.length === 0 ? (
        <p
          role="note"
          className="break-words rounded-lg border border-amber-300 bg-white px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900"
        >
          付与できるゲストロールがありません。テナントの高度ロール設定を確認してください。
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="min-w-0 space-y-3 rounded-lg border border-amber-200 bg-white p-3"
          data-testid="guest-invite-form"
        >
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label
                htmlFor="guest-invite-email"
                className="mb-1 block text-[0.6875rem] font-medium text-slate-700"
              >
                メールアドレス <span aria-hidden="true">*</span>
              </label>
              <input
                id="guest-invite-email"
                data-testid="guest-invite-email"
                name="guestInviteEmail"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-describedby="guest-invite-domain-guidance"
                placeholder="guest@partner.example"
                className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
              />
            </div>
            <div className="min-w-0">
              <label
                htmlFor="guest-invite-display-name"
                className="mb-1 block text-[0.6875rem] font-medium text-slate-700"
              >
                表示名
              </label>
              <input
                id="guest-invite-display-name"
                data-testid="guest-invite-display-name"
                name="guestInviteDisplayName"
                type="text"
                autoComplete="name"
                spellCheck={false}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="山田 太郎"
                className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
              />
            </div>
            <div className="min-w-0">
              <label
                htmlFor="guest-invite-org"
                className="mb-1 block text-[0.6875rem] font-medium text-slate-700"
              >
                外部組織名
              </label>
              <input
                id="guest-invite-org"
                data-testid="guest-invite-org"
                name="guestInviteOrg"
                type="text"
                autoComplete="organization"
                spellCheck={false}
                value={externalOrg}
                onChange={(event) => setExternalOrg(event.target.value)}
                placeholder="Partner Inc."
                className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
              />
            </div>
            <div className="min-w-0">
              <label
                htmlFor="guest-invite-role"
                className="mb-1 block text-[0.6875rem] font-medium text-slate-700"
              >
                付与するロール
              </label>
              <select
                id="guest-invite-role"
                data-testid="guest-invite-role"
                name="guestInviteRole"
                value={safeRole}
                onChange={(event) =>
                  setRole(event.target.value as ResourceRole)
                }
                className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 focus:border-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
              >
                {roleOptions.map((option) => (
                  <option key={option.role} value={option.role}>
                    {option.label} — {option.description}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p
            id="guest-invite-domain-guidance"
            className="break-words rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-slate-700"
          >
            {guestDomainGuidance(guestPolicy?.externalDomainAllowlist ?? [])}
          </p>

          <ul className="list-disc space-y-1 pl-4 text-[0.6875rem] leading-relaxed text-amber-900">
            {disabledReasonNotes.map((note) => (
              <li key={note} className="break-words">
                {note}
              </li>
            ))}
          </ul>
          <p className="break-words rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-sky-900">
            {GUEST_SHARED_LINK_NOTE}
          </p>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewOpen((open) => !open)}
              aria-expanded={previewOpen}
              aria-controls="guest-mail-preview-panel"
              data-testid="guest-mail-preview-toggle"
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[0.75rem] font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
            >
              <Mail className="h-3.5 w-3.5" />
              <span>招待メールプレビュー</span>
              {previewOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="submit"
              data-testid="guest-invite-submit"
              disabled={submitting}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-[0.75rem] font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span>{submitting ? '送信中...' : '招待を送信'}</span>
            </button>
          </div>

          {previewOpen && (
            <div
              id="guest-mail-preview-panel"
              data-testid="guest-mail-preview-panel"
              className="min-w-0 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <p className="break-words text-[0.6875rem] font-semibold text-slate-800">
                件名: {mailPreview.subject}
              </p>
              <pre className="max-h-56 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-white p-2.5 font-sans text-[0.6875rem] leading-relaxed text-slate-800">
                {mailPreview.bodyPreview}
              </pre>
              <p className="flex items-start gap-1.5 break-words text-[0.625rem] leading-relaxed text-slate-600">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                招待トークンは本文に表示されません。実際のメールには承諾用リンクが含まれます。
              </p>
            </div>
          )}
        </form>
      )}

      <div
        className="min-h-0 space-y-1 text-[0.6875rem]"
        aria-live="polite"
      >
        {notice && (
          <p
            role="status"
            data-testid="guest-collaboration-notice"
            className="flex items-start gap-1.5 break-words rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-800"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice}</span>
          </p>
        )}
        {error && (
          <p
            role="alert"
            data-testid="guest-collaboration-error"
            className="flex items-start gap-1.5 break-words rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-800"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h4 className="text-[0.6875rem] font-semibold text-amber-950">
            この{targetType === 'folder' ? 'フォルダ' : 'ファイル'}のゲスト招待 (
            {guestInvitations.length})
          </h4>
        </div>
        {guestInvitations.length === 0 ? (
          <p
            data-testid="guest-invitation-empty"
            className="break-words rounded-lg border border-dashed border-amber-300 bg-white px-3 py-3 text-center text-[0.6875rem] text-slate-600"
          >
            このリソースへのゲスト招待はまだありません。
          </p>
        ) : (
          <ul className="min-w-0 space-y-2">
            {guestInvitations.map((invitation) => {
              const busy = busyInvitationId === invitation.id;
              const confirming =
                confirmAction?.invitationId === invitation.id
                  ? confirmAction.kind
                  : null;
              return (
                <li
                  key={invitation.id}
                  data-testid="guest-invitation-row"
                  className="min-w-0 space-y-2 rounded-lg border border-amber-200 bg-white px-3 py-2.5 text-[0.6875rem] leading-relaxed"
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-all font-medium text-slate-900">
                        {invitation.email}
                      </p>
                      <p className="break-words text-slate-600">
                        {invitation.displayName}
                        {invitation.externalOrg
                          ? ` / ${invitation.externalOrg}`
                          : ''}
                      </p>
                    </div>
                    <span
                      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                        invitation.status === 'pending'
                          ? 'bg-blue-50 text-blue-700'
                          : invitation.status === 'accepted'
                            ? 'bg-emerald-50 text-emerald-700'
                            : invitation.status === 'expired'
                              ? 'bg-amber-50 text-amber-800'
                              : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {guestInvitationStatusLabel(invitation.status)}
                    </span>
                  </div>
                  <dl className="grid min-w-0 grid-cols-1 gap-1 text-[0.625rem] text-slate-600 sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="inline font-semibold">ロール: </dt>
                      <dd className="inline break-words">
                        {ROLE_META[invitation.role]?.label ?? invitation.role}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="inline font-semibold">有効期限: </dt>
                      <dd className="inline break-words">
                        {formatDateTime(invitation.expiresAt)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="inline font-semibold">最終送信: </dt>
                      <dd className="inline break-words">
                        {formatDateTime(invitation.lastSentAt)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="inline font-semibold">再送回数: </dt>
                      <dd className="inline">{invitation.resendCount} 回</dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="inline font-semibold">招待者: </dt>
                      <dd className="inline break-words">
                        {invitation.invitedByName ??
                          invitation.invitedBy ??
                          '不明'}
                      </dd>
                    </div>
                  </dl>

                  {confirming ? (
                    <div
                      role="group"
                      aria-label={
                        confirming === 'resend'
                          ? '招待メール再送の確認'
                          : '招待取消の確認'
                      }
                      data-testid="guest-invitation-confirm"
                      className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5"
                    >
                      <span className="min-w-0 break-words text-[0.625rem] text-amber-900">
                        {confirming === 'resend'
                          ? '新しいトークンで招待メールを再送します。よろしいですか？'
                          : '招待を取り消し、ゲストの有効セッションも失効させます。よろしいですか？'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void runInvitationAction(invitation, confirming)}
                        disabled={busy}
                        className="inline-flex min-h-7 items-center gap-1 rounded-md bg-amber-700 px-2 py-1 text-[0.625rem] font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
                      >
                        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                        実行
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmAction(null)}
                        disabled={busy}
                        className="inline-flex min-h-7 items-center rounded-md border border-slate-300 bg-white px-2 py-1 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        キャンセル
                      </button>
                    </div>
                  ) : (
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {invitation.userId && (
                        <button
                          type="button"
                          data-testid={`guest-invitation-detail-${invitation.id}`}
                          onClick={() =>
                            onOpenGuestDetail(invitation.userId as string)
                          }
                          className="inline-flex min-h-7 items-center gap-1 rounded-md border border-sky-300 bg-white px-2 py-1 text-[0.625rem] font-medium text-sky-800 hover:bg-sky-50"
                        >
                          ゲスト詳細
                        </button>
                      )}
                      {invitation.status === 'pending' && (
                        <button
                          type="button"
                          data-testid={`guest-invitation-resend-${invitation.id}`}
                          onClick={() =>
                            setConfirmAction({
                              kind: 'resend',
                              invitationId: invitation.id,
                            })
                          }
                          disabled={Boolean(busyInvitationId)}
                          className="inline-flex min-h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" />
                          再送
                        </button>
                      )}
                      {(invitation.status === 'pending' ||
                        invitation.status === 'accepted') && (
                        <button
                          type="button"
                          data-testid={`guest-invitation-revoke-${invitation.id}`}
                          onClick={() =>
                            setConfirmAction({
                              kind: 'revoke',
                              invitationId: invitation.id,
                            })
                          }
                          disabled={Boolean(busyInvitationId)}
                          className="inline-flex min-h-7 items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          <Ban className="h-3 w-3" />
                          取消
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export { invitationActionError };
