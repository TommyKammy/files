'use client';

import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { canManageAuthControls } from '@/lib/admin-ip-sso';
import { ApiClientError, fetchAdminSsoStatus } from '@/lib/files-api';
import type {
  AdminSsoStatusResponse,
  AuthUser,
  TenantPolicyRow,
} from '@/types/files';
import { IpAllowlistForm } from './auth-control/IpAllowlistForm';
import { SsoPolicyForm } from './auth-control/SsoPolicyForm';
import { SsoStatusPanel } from './auth-control/SsoStatusPanel';

/** Admin authentication control section for IP allowlist and OIDC SSO policies. */
export function AdminAuthControlSection({
  user,
  policy,
  initialSsoStatus,
  onPolicyUpdated,
  topicFilter = 'all',
}: {
  user: AuthUser;
  policy: TenantPolicyRow | null;
  initialSsoStatus?: AdminSsoStatusResponse | null;
  onPolicyUpdated?: (policy: TenantPolicyRow) => void;
  /** 1-Screen-1-Topic projection for the Enterprise settings workbench. */
  topicFilter?: 'ip-allowlist' | 'sso-oidc' | 'all';
}) {
  const canManage = canManageAuthControls(user.role);
  const showIpAllowlist =
    topicFilter === 'all' || topicFilter === 'ip-allowlist';
  const showSso = topicFilter === 'all' || topicFilter === 'sso-oidc';

  const [status, setStatus] = useState<AdminSsoStatusResponse | null>(
    () => initialSsoStatus ?? null
  );
  const [statusLoading, setStatusLoading] = useState(
    () => initialSsoStatus === undefined
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [callbackCopied, setCallbackCopied] = useState(false);

  useEffect(() => {
    if (initialSsoStatus !== undefined) {
      if (initialSsoStatus) {
        setStatus(initialSsoStatus);
        setStatusError(null);
      }
      setStatusLoading(false);
      return;
    }
    let active = true;
    setStatusLoading(true);
    fetchAdminSsoStatus()
      .then((response) => {
        if (!active) return;
        setStatus(response);
        setStatusError(null);
      })
      .catch((err) => {
        if (!active) return;
        setStatusError(
          err instanceof ApiClientError
            ? err.message
            : 'SSO ステータスの取得に失敗しました'
        );
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });
    return () => {
      active = false;
    };
  }, [initialSsoStatus]);

  async function refreshStatus(probeDiscovery: boolean) {
    if (probeDiscovery) setProbeLoading(true);
    else setStatusLoading(true);
    try {
      const response = await fetchAdminSsoStatus({ probeDiscovery });
      setStatus(response);
      setStatusError(null);
    } catch (err) {
      setStatusError(
        err instanceof ApiClientError
          ? err.message
          : 'SSO ステータスの取得に失敗しました'
      );
    } finally {
      if (probeDiscovery) setProbeLoading(false);
      else setStatusLoading(false);
    }
  }

  async function copyCallbackUrl() {
    if (!status?.callbackUrl) return;
    try {
      await navigator.clipboard.writeText(status.callbackUrl);
      setCallbackCopied(true);
      window.setTimeout(() => setCallbackCopied(false), 2000);
    } catch {
      setCallbackCopied(false);
    }
  }

  const localDevWarning =
    status?.environment === 'local' || status?.allowDevAuth === true;

  return (
    <section
      id="admin-auth-control-section"
      data-testid="admin-auth-control-section"
      aria-labelledby="auth-control-heading"
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" />
        <h2
          id="auth-control-heading"
          className="text-sm font-semibold text-slate-900"
        >
          IP 許可リスト & OIDC SSO 認証統制
        </h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
          {canManage ? 'sys_admin 編集可能' : 'sec_admin 閲覧のみ'}
        </span>
      </div>

      {!canManage && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
          IP 許可リストと OIDC SSO
          ポリシーを変更できるのはシステム管理者（sys_admin）だけです。セキュリティ管理者（sec_admin）は現在の設定と
          IdP ステータスを読み取り専用で確認できます。
        </p>
      )}

      {showIpAllowlist && (
        <IpAllowlistForm
          canManage={canManage}
          policy={policy}
          clientIp={status?.clientIp}
          onPolicyUpdated={onPolicyUpdated}
          onRefreshStatus={() => void refreshStatus(false)}
        />
      )}

      {showSso && (
        <SsoStatusPanel
          status={status}
          statusLoading={statusLoading}
          statusError={statusError}
          probeLoading={probeLoading}
          callbackCopied={callbackCopied}
          localDevWarning={localDevWarning}
          onProbeDiscovery={() => void refreshStatus(true)}
          onCopyCallbackUrl={() => void copyCallbackUrl()}
        />
      )}

      {showSso && (
        <SsoPolicyForm
          canManage={canManage}
          policy={policy}
          onPolicyUpdated={onPolicyUpdated}
          onRefreshStatus={() => void refreshStatus(false)}
        />
      )}
    </section>
  );
}
