'use client';

import {
  AlertTriangle,
  Building2,
  FileLock2,
  Gauge,
  Loader2,
  Save,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  formatTosAudienceLabel,
  readBranding,
  readFileRequestPolicy,
  readQuotaThresholds,
  TOS_AUDIENCE_LABELS,
  TOS_AUDIENCE_OPTIONS,
  validateQuotaThresholds,
} from '@/lib/admin-compliance';
import {
  ApiClientError,
  fetchAdminTos,
  updateAdminPolicies,
  updateAdminTos,
} from '@/lib/files-api';
import type {
  AdminTosPolicy,
  TenantPolicyRow,
  TosTargetAudience,
} from '@/types/files';

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    return err.code ? `${err.message} (${err.code})` : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

const MAX_FILE_REQUEST_BYTES = 10 * 1024 * 1024 * 1024;

export function AdminComplianceSettingsSection({
  policy,
  canManage,
  onPolicyUpdated,
}: {
  policy: TenantPolicyRow | null;
  canManage: boolean;
  onPolicyUpdated: (policy: TenantPolicyRow | null) => void;
}) {
  const persistedFileRequests = readFileRequestPolicy(policy);
  const persistedBranding = readBranding(policy);
  const persistedThresholds = readQuotaThresholds(policy);

  const [tos, setTos] = useState<AdminTosPolicy | null>(null);
  const [tosLoading, setTosLoading] = useState(true);
  const [tosSaving, setTosSaving] = useState(false);
  const [tosError, setTosError] = useState<string | null>(null);
  const [tosNotice, setTosNotice] = useState<string | null>(null);
  const [tosEnabled, setTosEnabled] = useState(false);
  const [tosAudience, setTosAudience] =
    useState<TosTargetAudience>('all_users');
  const [tosTitle, setTosTitle] = useState('利用規約');
  const [tosBody, setTosBody] = useState('');
  const [tosBumpVersion, setTosBumpVersion] = useState(false);

  const [allowFileRequests, setAllowFileRequests] = useState(
    persistedFileRequests.allowFileRequests
  );
  const [fileRequestMaxMiB, setFileRequestMaxMiB] = useState(
    String(Math.max(1, Math.round(persistedFileRequests.fileRequestMaxSizeBytes / (1024 * 1024))))
  );
  const [enforceExtensions, setEnforceExtensions] = useState(
    persistedFileRequests.fileRequestEnforceAllowedExtensions
  );
  const [brandingOrgName, setBrandingOrgName] = useState(
    persistedBranding.orgName ?? ''
  );
  const [brandingContactInfo, setBrandingContactInfo] = useState(
    persistedBranding.contactInfo ?? ''
  );
  const [brandingFooterNote, setBrandingFooterNote] = useState(
    persistedBranding.footerNote ?? ''
  );
  const [quotaWarn, setQuotaWarn] = useState(String(persistedThresholds.warn));
  const [quotaCritical, setQuotaCritical] = useState(
    String(persistedThresholds.critical)
  );
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setTosLoading(true);
      try {
        const response = await fetchAdminTos();
        if (cancelled) return;
        setTos(response.tos);
        setTosEnabled(response.tos.enabled);
        setTosAudience(response.tos.targetAudience);
        setTosTitle(response.tos.title);
        setTosBody(response.tos.bodyMarkdown);
        setTosError(null);
      } catch (err) {
        if (!cancelled) {
          setTosError(errorText(err, '利用規約の読み込みに失敗しました'));
        }
      } finally {
        if (!cancelled) setTosLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const nextFileRequests = readFileRequestPolicy(policy);
    const nextBranding = readBranding(policy);
    const nextThresholds = readQuotaThresholds(policy);
    setAllowFileRequests(nextFileRequests.allowFileRequests);
    setFileRequestMaxMiB(
      String(
        Math.max(
          1,
          Math.round(nextFileRequests.fileRequestMaxSizeBytes / (1024 * 1024))
        )
      )
    );
    setEnforceExtensions(nextFileRequests.fileRequestEnforceAllowedExtensions);
    setBrandingOrgName(nextBranding.orgName ?? '');
    setBrandingContactInfo(nextBranding.contactInfo ?? '');
    setBrandingFooterNote(nextBranding.footerNote ?? '');
    setQuotaWarn(String(nextThresholds.warn));
    setQuotaCritical(String(nextThresholds.critical));
  }, [policy]);

  async function handleSaveTos(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || tosSaving) return;
    setTosSaving(true);
    setTosError(null);
    setTosNotice(null);
    try {
      const response = await updateAdminTos({
        enabled: tosEnabled,
        targetAudience: tosAudience,
        title: tosTitle.trim(),
        bodyMarkdown: tosBody,
        bumpVersion: tosBumpVersion,
      });
      setTos(response.tos);
      setTosEnabled(response.tos.enabled);
      setTosAudience(response.tos.targetAudience);
      setTosTitle(response.tos.title);
      setTosBody(response.tos.bodyMarkdown);
      setTosBumpVersion(false);
      setTosNotice(
        `利用規約を保存しました (v${response.tos.version}${
          response.tos.enabled ? '・有効' : '・無効'
        })`
      );
    } catch (err) {
      setTosError(errorText(err, '利用規約の保存に失敗しました'));
    } finally {
      setTosSaving(false);
    }
  }

  async function handleSavePolicy(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || policySaving) return;
    setPolicyError(null);
    setPolicyNotice(null);

    const maxMiB = Number(fileRequestMaxMiB);
    if (!Number.isInteger(maxMiB) || maxMiB < 1) {
      setPolicyError('ファイルリクエスト上限サイズは 1 MiB 以上の整数で指定してください。');
      return;
    }
    const maxBytes = maxMiB * 1024 * 1024;
    if (maxBytes > MAX_FILE_REQUEST_BYTES) {
      setPolicyError('ファイルリクエスト上限サイズは 10 GiB 以下で指定してください。');
      return;
    }
    const warn = Number(quotaWarn);
    const critical = Number(quotaCritical);
    const thresholdValidation = validateQuotaThresholds(warn, critical);
    if (!thresholdValidation.ok) {
      setPolicyError(thresholdValidation.error ?? 'クォータ閾値が不正です。');
      return;
    }

    setPolicySaving(true);
    try {
      const response = await updateAdminPolicies({
        allowFileRequests,
        fileRequestMaxSizeBytes: maxBytes,
        fileRequestEnforceAllowedExtensions: enforceExtensions,
        brandingOrgName: brandingOrgName.trim() || null,
        brandingContactInfo: brandingContactInfo.trim() || null,
        brandingFooterNote: brandingFooterNote.trim() || null,
        quotaWarnThresholdPct: warn,
        quotaCriticalThresholdPct: critical,
      });
      onPolicyUpdated(response.policy);
      setPolicyNotice(
        'ファイルリクエスト方針・テナントブランディング・クォータ閾値を保存しました'
      );
    } catch (err) {
      setPolicyError(errorText(err, 'ガバナンス設定の保存に失敗しました'));
    } finally {
      setPolicySaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="admin-tos-heading"
        data-testid="admin-tos-section"
        className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="admin-tos-heading"
              className="flex items-center gap-2 text-sm font-semibold text-slate-900"
            >
              <Scale className="h-4 w-4 text-[#5e6ad2]" />
              カスタム利用規約 (ToS) 同意管理
            </h2>
            <p className="mt-1 text-[0.6875rem] text-[#55565a]">
              有効化すると対象ユーザーは最新バージョンへの同意までワークスペース API
              を利用できません。本文・タイトル変更またはバージョン更新で再同意を強制できます。
            </p>
          </div>
          <span
            data-testid="admin-tos-version"
            className="rounded-full border border-[#d9dcf5] bg-[#eef0fc] px-2.5 py-0.5 text-[0.625rem] font-medium text-[#3f4a9e]"
          >
            v{tos?.version ?? 1} / {tos?.enabled ? '有効' : '無効'}
          </span>
        </div>

        {tosLoading ? (
          <div className="mt-4 flex items-center gap-2 text-[0.75rem] text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            利用規約を読み込み中...
          </div>
        ) : (
          <form onSubmit={handleSaveTos} className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-[0.75rem] font-medium text-slate-700">
                <input
                  data-testid="admin-tos-enabled"
                  type="checkbox"
                  checked={tosEnabled}
                  disabled={!canManage}
                  onChange={(event) => setTosEnabled(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-[#5e6ad2]"
                />
                カスタム利用規約を有効化
              </label>
              <label className="inline-flex items-center gap-2 text-[0.75rem] text-slate-700">
                対象:
                <select
                  data-testid="admin-tos-audience"
                  value={tosAudience}
                  disabled={!canManage}
                  onChange={(event) =>
                    setTosAudience(event.target.value as TosTargetAudience)
                  }
                  className="h-8 rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem]"
                >
                  {TOS_AUDIENCE_OPTIONS.map((audience) => (
                    <option key={audience} value={audience}>
                      {TOS_AUDIENCE_LABELS[audience]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block text-[0.75rem]">
              <span className="font-medium text-slate-700">タイトル</span>
              <input
                data-testid="admin-tos-title"
                type="text"
                maxLength={160}
                required
                value={tosTitle}
                disabled={!canManage}
                onChange={(event) => setTosTitle(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[#d7d7dc] px-3 py-2 text-[0.8125rem]"
              />
            </label>

            <label className="block text-[0.75rem]">
              <span className="font-medium text-slate-700">
                本文 (Markdown / プレーンテキスト)
              </span>
              <textarea
                data-testid="admin-tos-body"
                rows={10}
                value={tosBody}
                disabled={!canManage}
                onChange={(event) => setTosBody(event.target.value)}
                placeholder={'# 利用規約\n\n- 機密情報の取り扱い\n- 共有リンクの利用範囲'}
                className="mt-1 w-full resize-y rounded-lg border border-[#d7d7dc] px-3 py-2 font-mono text-[0.75rem] leading-relaxed"
              />
              <span className="mt-1 block text-[0.625rem] text-[#6b6f76]">
                表示時に Markdown 見出し・箇条書きのみを安全に整形します。HTML
                は描画されません。
              </span>
            </label>

            <label className="inline-flex items-center gap-2 text-[0.75rem] text-slate-700">
              <input
                data-testid="admin-tos-bump-version"
                type="checkbox"
                checked={tosBumpVersion}
                disabled={!canManage}
                onChange={(event) => setTosBumpVersion(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-[#5e6ad2]"
              />
              バージョンを更新して既存ユーザーへ再同意を要求する
            </label>

            {tosError && (
              <p
                role="alert"
                data-testid="admin-tos-error"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {tosError}
              </p>
            )}
            {tosNotice && (
              <p
                role="status"
                data-testid="admin-tos-notice"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
              >
                {tosNotice}
              </p>
            )}

            {!canManage && (
              <p className="text-[0.625rem] text-amber-700">
                sec_admin は閲覧のみ可能です。変更は sys_admin が行ってください。
              </p>
            )}

            <button
              type="submit"
              data-testid="admin-tos-save"
              disabled={!canManage || tosSaving}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {tosSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              利用規約を保存
            </button>
          </form>
        )}
      </section>

      <section
        aria-labelledby="admin-governance-policy-heading"
        data-testid="admin-governance-policy-section"
        className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
      >
        <div>
          <h2
            id="admin-governance-policy-heading"
            className="flex items-center gap-2 text-sm font-semibold text-slate-900"
          >
            <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" />
            ファイルリクエスト方針・ブランディング・クォータ警告
          </h2>
          <p className="mt-1 text-[0.6875rem] text-[#55565a]">
            全社の Blind Dropbox の許可・上限・拡張子強制、公開画面の組織情報、
            ストレージ警告しきい値を一括管理します。
          </p>
        </div>

        <form onSubmit={handleSavePolicy} className="mt-4 space-y-5">
          <fieldset className="space-y-3 rounded-xl border border-[#ececef] p-4">
            <legend className="flex items-center gap-1.5 px-1 text-[0.75rem] font-semibold text-slate-800">
              <FileLock2 className="h-3.5 w-3.5 text-[#5e6ad2]" />
              全社ファイルリクエスト
            </legend>
            <label className="inline-flex items-center gap-2 text-[0.75rem] text-slate-700">
              <input
                data-testid="admin-file-request-allow"
                type="checkbox"
                checked={allowFileRequests}
                disabled={!canManage}
                onChange={(event) => setAllowFileRequests(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-[#5e6ad2]"
              />
              全社でファイルリクエスト作成・受付を許可する
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-[0.75rem]">
                <span className="font-medium text-slate-700">
                  全社上限サイズ (MiB)
                </span>
                <input
                  data-testid="admin-file-request-max-size"
                  type="number"
                  min={1}
                  max={MAX_FILE_REQUEST_BYTES / (1024 * 1024)}
                  required
                  value={fileRequestMaxMiB}
                  disabled={!canManage}
                  onChange={(event) => setFileRequestMaxMiB(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </label>
              <label className="mt-5 inline-flex items-center gap-2 text-[0.75rem] text-slate-700">
                <input
                  data-testid="admin-file-request-enforce-ext"
                  type="checkbox"
                  checked={enforceExtensions}
                  disabled={!canManage}
                  onChange={(event) => setEnforceExtensions(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-[#5e6ad2]"
                />
                許可拡張子の指定を必須化
              </label>
            </div>
          </fieldset>

          <fieldset className="space-y-3 rounded-xl border border-[#ececef] p-4">
            <legend className="flex items-center gap-1.5 px-1 text-[0.75rem] font-semibold text-slate-800">
              <Building2 className="h-3.5 w-3.5 text-[#5e6ad2]" />
              テナントブランディング
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-[0.75rem]">
                <span className="font-medium text-slate-700">組織表示名</span>
                <input
                  data-testid="admin-branding-org-name"
                  type="text"
                  maxLength={120}
                  value={brandingOrgName}
                  disabled={!canManage}
                  onChange={(event) => setBrandingOrgName(event.target.value)}
                  placeholder="例: 株式会社サンプル"
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </label>
              <label className="block text-[0.75rem]">
                <span className="font-medium text-slate-700">問い合わせ先</span>
                <input
                  data-testid="admin-branding-contact-info"
                  type="text"
                  maxLength={500}
                  value={brandingContactInfo}
                  disabled={!canManage}
                  onChange={(event) => setBrandingContactInfo(event.target.value)}
                  placeholder="例: security@example.com / 03-0000-0000"
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </label>
            </div>
            <label className="block text-[0.75rem]">
              <span className="font-medium text-slate-700">法務フッター注記</span>
              <textarea
                data-testid="admin-branding-footer-note"
                rows={2}
                maxLength={500}
                value={brandingFooterNote}
                disabled={!canManage}
                onChange={(event) => setBrandingFooterNote(event.target.value)}
                placeholder="例: 本リンクの利用は秘密保持契約に準拠します。"
                className="mt-1 w-full resize-y rounded-md border border-[#d7d7dc] px-2.5 py-1.5 text-[0.75rem]"
              />
            </label>
            <p className="text-[0.625rem] text-[#6b6f76]">
              共有リンク・ファイル収集・ゲスト招待・利用規約モーダルに、HTML
              エスケープされたテキストとして表示されます。
            </p>
          </fieldset>

          <fieldset className="space-y-3 rounded-xl border border-[#ececef] p-4">
            <legend className="flex items-center gap-1.5 px-1 text-[0.75rem] font-semibold text-slate-800">
              <Gauge className="h-3.5 w-3.5 text-[#5e6ad2]" />
              クォータ警告しきい値
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-[0.75rem]">
                <span className="font-medium text-slate-700">警告 (%)</span>
                <input
                  data-testid="admin-quota-warn"
                  type="number"
                  min={50}
                  max={99}
                  required
                  value={quotaWarn}
                  disabled={!canManage}
                  onChange={(event) => setQuotaWarn(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </label>
              <label className="block text-[0.75rem]">
                <span className="font-medium text-slate-700">緊急 (%)</span>
                <input
                  data-testid="admin-quota-critical"
                  type="number"
                  min={51}
                  max={100}
                  required
                  value={quotaCritical}
                  disabled={!canManage}
                  onChange={(event) => setQuotaCritical(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </label>
            </div>
            <p className="text-[0.625rem] text-[#6b6f76]">
              警告 &lt; 緊急を満たす必要があります (既定 80% / 90%)。
            </p>
          </fieldset>

          {policyError && (
            <p
              role="alert"
              data-testid="admin-governance-policy-error"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {policyError}
            </p>
          )}
          {policyNotice && (
            <p
              role="status"
              data-testid="admin-governance-policy-notice"
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
            >
              {policyNotice}
            </p>
          )}

          <button
            type="submit"
            data-testid="admin-governance-policy-save"
            disabled={!canManage || policySaving}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            {policySaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            ガバナンス設定を保存
          </button>
        </form>
      </section>
    </div>
  );
}

/** Exposed for lightweight consumers that only need the policy summary. */
export function summarizeTosAudience(tos: AdminTosPolicy | null): string {
  return formatTosAudienceLabel(tos?.targetAudience ?? 'all_users');
}
