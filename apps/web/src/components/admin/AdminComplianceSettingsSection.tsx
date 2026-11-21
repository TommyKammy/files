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
import { useEffect, useRef, useState } from 'react';
import {
  BRANDING_ACCENT_COLOR_PRESETS,
  formatTosAudienceLabel,
  normalizeHexAccentColor,
  readBranding,
  readFileRequestPolicy,
  readQuotaThresholds,
  TOS_AUDIENCE_LABELS,
  TOS_AUDIENCE_OPTIONS,
  validateQuotaThresholds,
} from '@/lib/admin-compliance';
import {
  ApiClientError,
  deleteAdminBrandingLogo,
  fetchAdminTos,
  updateAdminPolicies,
  updateAdminTos,
  uploadAdminBrandingLogo,
} from '@/lib/files-api';
import type {
  AdminTosPolicy,
  AiClassificationMode,
  TenantPolicyRow,
  TosTargetAudience,
} from '@/types/files';
import { AdminLegalHoldsSection } from './AdminLegalHoldsSection';

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
  initialTos,
  onPolicyUpdated,
  topicFilter = 'all',
  tenantPolicy,
  tenantPolicySaving,
  onTenantPolicyChange,
  onTenantPolicySubmit,
}: {
  policy: TenantPolicyRow | null;
  canManage: boolean;
  initialTos?: AdminTosPolicy | null;
  onPolicyUpdated: (policy: TenantPolicyRow | null) => void;
  /** 1-Screen-1-Topic projection for the Enterprise settings workbench. */
  topicFilter?: 'tos' | 'file-requests' | 'retention-quota-ai' | 'branding' | 'all';
  /**
   * Optional parent-owned policy row. When supplied, the retention / AI
   * fieldsets become editable and the parent can own persistence instead of
   * the locally managed governance form.
   */
  tenantPolicy?: TenantPolicyRow | null;
  tenantPolicySaving?: boolean;
  onTenantPolicyChange?: (next: TenantPolicyRow) => void;
  onTenantPolicySubmit?: (event: React.FormEvent) => void;
}) {
  const showTos = topicFilter === 'all' || topicFilter === 'tos';
  const showGovernancePolicy = topicFilter !== 'tos';
  const showFileRequests =
    topicFilter === 'all' || topicFilter === 'file-requests';
  const showBranding = topicFilter === 'all' || topicFilter === 'branding';
  const showQuotaThresholds =
    topicFilter === 'all' || topicFilter === 'retention-quota-ai';
  const showRetention =
    topicFilter === 'all' || topicFilter === 'retention-quota-ai';
  const governanceTitle =
    topicFilter === 'file-requests'
      ? '全社ファイルリクエスト方針'
      : topicFilter === 'branding'
        ? 'カスタムブランディング'
        : topicFilter === 'retention-quota-ai'
          ? '保持期間・容量警告・AI 分類'
          : 'ファイルリクエスト方針・ブランディング・クォータ警告';
  const governanceSummary =
    topicFilter === 'file-requests'
      ? '全社の Blind Dropbox の許可・上限・拡張子強制を管理します。'
      : topicFilter === 'branding'
        ? '共有リンク・ファイルリクエスト・ゲスト招待画面に表示する組織情報を管理します。'
        : topicFilter === 'retention-quota-ai'
          ? 'ゴミ箱の保持日数・AI 自動分類モード・ストレージ容量の警告しきい値を管理します。'
          : '全社の Blind Dropbox の許可・上限・拡張子強制、公開画面の組織情報、ストレージ警告しきい値を一括管理します。';
  const persistedFileRequests = readFileRequestPolicy(policy);
  const persistedBranding = readBranding(policy);
  const persistedThresholds = readQuotaThresholds(policy);

  const lastInitialTosRef = useRef<AdminTosPolicy | null | undefined>(
    initialTos
  );
  const [tos, setTos] = useState<AdminTosPolicy | null>(() => initialTos ?? null);
  const [tosLoading, setTosLoading] = useState(() => initialTos === undefined);
  const [tosSaving, setTosSaving] = useState(false);
  const [tosError, setTosError] = useState<string | null>(null);
  const [tosNotice, setTosNotice] = useState<string | null>(null);
  const [tosEnabled, setTosEnabled] = useState(() => initialTos?.enabled ?? false);
  const [tosAudience, setTosAudience] = useState<TosTargetAudience>(
    () => initialTos?.targetAudience ?? 'all_users'
  );
  const [tosTitle, setTosTitle] = useState(() => initialTos?.title ?? '利用規約');
  const [tosBody, setTosBody] = useState(() => initialTos?.bodyMarkdown ?? '');
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
  const [brandingAccentColor, setBrandingAccentColor] = useState(
    persistedBranding.accentColor ?? ''
  );
  const [brandingLogoUrl, setBrandingLogoUrl] = useState<string | null>(
    persistedBranding.logoUrl ?? null
  );
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoCacheBust, setLogoCacheBust] = useState(0);
  const [quotaWarn, setQuotaWarn] = useState(String(persistedThresholds.warn));
  const [quotaCritical, setQuotaCritical] = useState(
    String(persistedThresholds.critical)
  );
  const [trashRetentionDays, setTrashRetentionDays] = useState(
    String(policy?.trash_retention_days ?? 30)
  );
  const [aiClassificationMode, setAiClassificationMode] =
    useState<AiClassificationMode>(
      policy?.ai_classification_mode ?? 'metadata_only'
    );
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);

  useEffect(() => {
    if (initialTos !== undefined) {
      if (initialTos && initialTos !== lastInitialTosRef.current) {
        lastInitialTosRef.current = initialTos;
        setTos(initialTos);
        setTosEnabled(initialTos.enabled);
        setTosAudience(initialTos.targetAudience);
        setTosTitle(initialTos.title);
        setTosBody(initialTos.bodyMarkdown);
        setTosError(null);
      }
      setTosLoading(false);
      return;
    }
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
  }, [initialTos]);

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
    setTrashRetentionDays(String(policy?.trash_retention_days ?? 30));
    setAiClassificationMode(
      policy?.ai_classification_mode ?? 'metadata_only'
    );
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
    const warn = tenantPolicy
      ? Number(
          tenantPolicy.quota_warn_threshold_pct ??
            tenantPolicy.quotaWarnThresholdPct ??
            persistedThresholds.warn
        )
      : Number(quotaWarn);
    const critical = tenantPolicy
      ? Number(
          tenantPolicy.quota_critical_threshold_pct ??
            tenantPolicy.quotaCriticalThresholdPct ??
            persistedThresholds.critical
        )
      : Number(quotaCritical);
    const thresholdValidation = validateQuotaThresholds(warn, critical);
    if (!thresholdValidation.ok) {
      setPolicyError(thresholdValidation.error ?? 'クォータ閾値が不正です。');
      return;
    }

    const trimmedAccent = brandingAccentColor.trim();
    const normalizedAccent = trimmedAccent
      ? normalizeHexAccentColor(trimmedAccent)
      : null;
    if (trimmedAccent && !normalizedAccent) {
      setPolicyError('アクセントカラーは #RRGGBB 形式で入力してください。');
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
        brandingAccentColor: normalizedAccent,
        quotaWarnThresholdPct: warn,
        quotaCriticalThresholdPct: critical,
        trashRetentionDays:
          tenantPolicy?.trash_retention_days ??
          Number(trashRetentionDays),
        aiClassificationMode:
          tenantPolicy?.ai_classification_mode ?? aiClassificationMode,
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

  async function handleLogoUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !canManage) return;
    setPolicyError(null);
    setPolicyNotice(null);

    if (file.size > 512 * 1024) {
      setPolicyError('ロゴ画像は 512 KiB 以下にしてください。');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setPolicyError('PNG・JPEG・WebP 形式の画像のみアップロードできます。');
      return;
    }

    setLogoUploading(true);
    try {
      const result = await uploadAdminBrandingLogo(file);
      setBrandingLogoUrl(result.logoUrl);
      setLogoCacheBust((n) => n + 1);
      if (policy) {
        onPolicyUpdated({ ...policy, brandingLogoUrl: result.logoUrl });
      }
      setPolicyNotice('組織ロゴをアップロードしました');
    } catch (err) {
      setPolicyError(errorText(err, '組織ロゴのアップロードに失敗しました'));
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleLogoDelete() {
    if (!canManage) return;
    setPolicyError(null);
    setPolicyNotice(null);
    setLogoUploading(true);
    try {
      await deleteAdminBrandingLogo();
      setBrandingLogoUrl(null);
      if (policy) {
        onPolicyUpdated({ ...policy, brandingLogoUrl: null });
      }
      setPolicyNotice('組織ロゴを削除しました');
    } catch (err) {
      setPolicyError(errorText(err, '組織ロゴの削除に失敗しました'));
    } finally {
      setLogoUploading(false);
    }
  }

  const effectivePolicySaving = tenantPolicySaving ?? policySaving;
  const retentionValue = String(
    tenantPolicy?.trash_retention_days ?? trashRetentionDays
  );
  const aiModeValue =
    tenantPolicy?.ai_classification_mode ?? aiClassificationMode;
  const quotaWarnValue = String(
    tenantPolicy?.quota_warn_threshold_pct ??
      tenantPolicy?.quotaWarnThresholdPct ??
      quotaWarn
  );
  const quotaCriticalValue = String(
    tenantPolicy?.quota_critical_threshold_pct ??
      tenantPolicy?.quotaCriticalThresholdPct ??
      quotaCritical
  );
  const canEditTenantPolicy = Boolean(
    tenantPolicy && onTenantPolicyChange
  );

  function updateRetentionDays(raw: string) {
    if (canEditTenantPolicy && tenantPolicy && onTenantPolicyChange) {
      onTenantPolicyChange({
        ...tenantPolicy,
        trash_retention_days: Number.parseInt(raw || '30', 10),
      });
      return;
    }
    setTrashRetentionDays(raw);
  }

  function updateAiMode(mode: AiClassificationMode) {
    if (canEditTenantPolicy && tenantPolicy && onTenantPolicyChange) {
      onTenantPolicyChange({
        ...tenantPolicy,
        ai_classification_mode: mode,
      });
      return;
    }
    setAiClassificationMode(mode);
  }

  function updateQuotaWarn(raw: string) {
    if (canEditTenantPolicy && tenantPolicy && onTenantPolicyChange) {
      onTenantPolicyChange({
        ...tenantPolicy,
        quota_warn_threshold_pct: Number.parseInt(raw || '80', 10),
      });
      return;
    }
    setQuotaWarn(raw);
  }

  function updateQuotaCritical(raw: string) {
    if (canEditTenantPolicy && tenantPolicy && onTenantPolicyChange) {
      onTenantPolicyChange({
        ...tenantPolicy,
        quota_critical_threshold_pct: Number.parseInt(raw || '90', 10),
      });
      return;
    }
    setQuotaCritical(raw);
  }

  return (
    <div className="space-y-4">
      {showTos && (
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
      )}

      {showGovernancePolicy && (
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
            {governanceTitle}
          </h2>
          <p className="mt-1 text-[0.6875rem] text-[#55565a]">
            {governanceSummary}
          </p>
        </div>

        <form
          onSubmit={onTenantPolicySubmit ?? handleSavePolicy}
          className="mt-4 space-y-5"
        >
          {showFileRequests && (
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
          )}

          {showBranding && (
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 text-[0.75rem]">
                <span className="block font-medium text-slate-700">
                  組織ロゴ (PNG / JPEG / WebP, 最大 512 KiB)
                </span>
                <div className="flex flex-wrap items-center gap-2.5">
                  {brandingLogoUrl ? (
                    <img
                      data-testid="admin-branding-logo-preview"
                      src={
                        logoCacheBust > 0
                          ? `${brandingLogoUrl}?v=${logoCacheBust}`
                          : brandingLogoUrl
                      }
                      alt={brandingOrgName.trim() || '組織ロゴ'}
                      className="h-10 max-w-[160px] rounded border border-[#e3e3e8] bg-white object-contain p-1"
                    />
                  ) : (
                    <span className="rounded border border-dashed border-[#d7d7dc] px-2.5 py-1.5 text-[0.6875rem] text-[#6b6f76]">
                      未設定
                    </span>
                  )}
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[#d7d7dc] bg-white px-2.5 py-1 text-[0.6875rem] font-medium text-slate-700 hover:bg-[#f7f7fa]">
                    <input
                      data-testid="admin-branding-logo-input"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={!canManage || logoUploading}
                      onChange={handleLogoUpload}
                      className="sr-only"
                    />
                    {logoUploading ? '処理中...' : 'ロゴを選択'}
                  </label>
                  {brandingLogoUrl && canManage && (
                    <button
                      type="button"
                      data-testid="admin-branding-logo-delete"
                      disabled={logoUploading}
                      onClick={handleLogoDelete}
                      className="rounded-md border border-[#f2c6c6] bg-white px-2.5 py-1 text-[0.6875rem] font-medium text-[#b91c1c] hover:bg-[#fff5f5] disabled:opacity-50"
                    >
                      削除
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1.5 text-[0.75rem]">
                <span className="block font-medium text-slate-700">
                  アクセントカラー (#RRGGBB)
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="color"
                    aria-label="アクセントカラー選択"
                    value={normalizeHexAccentColor(brandingAccentColor) ?? '#5e6ad2'}
                    disabled={!canManage}
                    onChange={(event) => setBrandingAccentColor(event.target.value)}
                    className="h-8 w-9 cursor-pointer rounded border border-[#d7d7dc] bg-white p-0.5 disabled:opacity-50"
                  />
                  <input
                    data-testid="admin-branding-accent-color"
                    type="text"
                    maxLength={7}
                    value={brandingAccentColor}
                    disabled={!canManage}
                    onChange={(event) => setBrandingAccentColor(event.target.value)}
                    placeholder="#2563eb"
                    className="h-8 w-28 rounded-md border border-[#d7d7dc] px-2.5 font-mono text-[0.75rem]"
                  />
                  {brandingAccentColor && canManage && (
                    <button
                      type="button"
                      onClick={() => setBrandingAccentColor('')}
                      className="rounded-md border border-[#d7d7dc] px-2 py-1 text-[0.6875rem] text-slate-600 hover:bg-[#f7f7fa]"
                    >
                      クリア
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {BRANDING_ACCENT_COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={!canManage}
                      aria-label={`プリセットカラー ${preset}`}
                      onClick={() => setBrandingAccentColor(preset)}
                      style={{ backgroundColor: preset }}
                      className={`h-5 w-5 rounded-full border transition ${
                        normalizeHexAccentColor(brandingAccentColor) === preset
                          ? 'ring-2 ring-slate-900 ring-offset-1 border-white'
                          : 'border-black/10 hover:scale-110'
                      }`}
                    />
                  ))}
                </div>
              </div>
            </div>
            <p className="text-[0.625rem] text-[#6b6f76]">
              共有リンク・ファイル収集・ゲスト招待・利用規約モーダルに、HTML
              エスケープされたテキストとして表示されます。
            </p>
          </fieldset>
          )}

          {showQuotaThresholds && (
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
                  value={quotaWarnValue}
                  disabled={!canManage}
                  onChange={(event) => updateQuotaWarn(event.target.value)}
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
                  value={quotaCriticalValue}
                  disabled={!canManage}
                  onChange={(event) => updateQuotaCritical(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </label>
            </div>
            <p className="text-[0.625rem] text-[#6b6f76]">
              警告 &lt; 緊急を満たす必要があります (既定 80% / 90%)。
            </p>
          </fieldset>
          )}

          {showRetention && (
          <fieldset className="space-y-3 rounded-xl border border-[#ececef] p-4">
            <legend className="flex items-center gap-1.5 px-1 text-[0.75rem] font-semibold text-slate-800">
              <Scale className="h-3.5 w-3.5 text-[#5e6ad2]" />
              データ保持と AI 自動分類
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-[0.75rem]">
                <span className="font-medium text-slate-700">
                  ゴミ箱の保持期間 (日)
                </span>
                <input
                  id="trash_retention_days"
                  name="trashRetentionDays"
                  data-testid="admin-trash-retention-days"
                  type="number"
                  min={1}
                  max={3650}
                  required
                  value={retentionValue}
                  disabled={!canManage}
                  onChange={(event) =>
                    updateRetentionDays(event.target.value)
                  }
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
                />
              </label>
              <label className="block text-[0.75rem]">
                <span className="font-medium text-slate-700">
                  AI 自動分類モード
                </span>
                <select
                  id="ai_classification_mode"
                  name="aiClassificationMode"
                  data-testid="admin-ai-classification-mode"
                  value={aiModeValue}
                  disabled={!canManage}
                  onChange={(event) =>
                    updateAiMode(event.target.value as AiClassificationMode)
                  }
                  className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem]"
                >
                  <option value="content_excerpt">
                    content_excerpt (本文先頭抽出)
                  </option>
                  <option value="metadata_only">
                    metadata_only (メタデータのみ)
                  </option>
                  <option value="disabled">disabled (停止)</option>
                </select>
              </label>
            </div>
            <p className="text-[0.625rem] text-[#6b6f76]">
              ゴミ箱の自動削除までの日数と、Workers AI
              が機密区分を提案するときの参照範囲を管理します。
            </p>
          </fieldset>
          )}

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
            disabled={!canManage || effectivePolicySaving}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            {effectivePolicySaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            ガバナンス設定を保存
          </button>
        </form>
      </section>
      )}
      {showRetention && <AdminLegalHoldsSection canManage={canManage} />}
    </div>
  );
}

/** Exposed for lightweight consumers that only need the policy summary. */
export function summarizeTosAudience(tos: AdminTosPolicy | null): string {
  return formatTosAudienceLabel(tos?.targetAudience ?? 'all_users');
}
