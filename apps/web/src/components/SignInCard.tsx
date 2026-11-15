'use client';

import { KeyRound, Loader2, LogOut, ShieldCheck, UserCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ApiClientError,
  buildLoginUrl,
  fetchCurrentUser,
  fetchDevAuthAccounts,
  loginWithDevAccount,
  logoutSession,
} from '@/lib/files-api';
import { getWorkspaceSyncStore } from '@/lib/sync-store';
import type { AuthUser, DevAuthAccount, UserRole } from '@/types/files';

const ROLE_LABEL: Record<UserRole, string> = {
  sys_admin: 'システム管理者 (sys_admin)',
  sec_admin: 'セキュリティ管理者 (sec_admin)',
  member: '一般メンバー (member)',
};

export function LocalDevQuickLoginPanel({
  preferredRoles,
  redirectTo,
  onSignedIn,
}: {
  preferredRoles?: UserRole[];
  redirectTo?: string;
  onSignedIn?: (user: AuthUser) => void;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<DevAuthAccount[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    const load = (attempt: number) => {
      fetchDevAuthAccounts().then((res) => {
        if (cancelled) return;
        if (res.enabled && res.accounts.length > 0) {
          setEnabled(true);
          setAccounts(res.accounts);
        } else if (attempt === 0) {
          // Retry briefly once in case wrangler dev finishes booting right after next dev
          retryTimer = window.setTimeout(() => load(1), 1200);
        }
      });
    };

    load(0);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  if (!enabled || accounts.length === 0) {
    return null;
  }

  async function handleDevLogin(account: DevAuthAccount) {
    setBusyId(account.id);
    setError(null);
    try {
      await loginWithDevAccount({ userId: account.id });
      const me = await fetchCurrentUser();
      await getWorkspaceSyncStore().adoptAuthenticatedUser(me.user);
      if (onSignedIn) {
        onSignedIn(me.user);
      }
      if (redirectTo) {
        router.push(redirectTo);
      } else if (!onSignedIn) {
        router.refresh();
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ローカル開発ログインに失敗しました'
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-left space-y-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold text-amber-900">
        <KeyRound className="h-3.5 w-3.5 text-amber-600" />
        <span>ローカル開発クイックサインイン（localhost 専用）</span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-1.5">
        {accounts.map((acc) => {
          const allowed = !preferredRoles || preferredRoles.includes(acc.role);
          const isBusy = busyId === acc.id;
          return (
            <button
              key={acc.id}
              type="button"
              disabled={busyId !== null}
              onClick={() => handleDevLogin(acc)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition disabled:opacity-50 ${
                allowed
                  ? 'border-amber-200 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50/50'
                  : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100'
              }`}
            >
              <div className="min-w-0">
                <div className="font-semibold truncate">{ROLE_LABEL[acc.role]}</div>
                <div className="truncate text-[11px] text-slate-500">
                  {acc.displayName} • {acc.email}
                </div>
              </div>
              <span className="shrink-0 inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white">
                {isBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <UserCheck className="h-3 w-3" />
                )}
                <span>ログイン</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SignInCard({
  title,
  description,
  returnTo,
  preferredRoles,
  onSignedIn,
}: {
  title: string;
  description?: string;
  returnTo: string;
  preferredRoles?: UserRole[];
  onSignedIn: (user: AuthUser) => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-6 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm space-y-5">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[#131B2E] text-base font-bold text-white">
          F
        </div>

        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
          {description && (
            <p className="text-xs leading-relaxed text-slate-500">{description}</p>
          )}
        </div>

        <a
          href={buildLoginUrl(returnTo)}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition"
        >
          <ShieldCheck className="h-4 w-4" />
          <span>SSO でサインイン</span>
        </a>

        <LocalDevQuickLoginPanel
          preferredRoles={preferredRoles}
          onSignedIn={onSignedIn}
        />
      </div>
    </main>
  );
}

export function HomeSessionControl() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetchCurrentUser()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;

  return (
    <div className="space-y-3">
      {user && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2.5 text-xs">
          <div className="min-w-0">
            <span className="font-semibold text-emerald-900">
              サインイン中: {user.displayName}
            </span>{' '}
            <span className="font-mono text-emerald-700">({user.role})</span>
            <div className="truncate text-[11px] text-emerald-700/80">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={() => logoutSession().then(() => setUser(null))}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-medium text-emerald-900 hover:bg-emerald-100/60"
          >
            <LogOut className="h-3 w-3" />
            <span>サインアウト</span>
          </button>
        </div>
      )}

      <LocalDevQuickLoginPanel
        redirectTo="/workspace"
        onSignedIn={(signedIn) => setUser(signedIn)}
      />
    </div>
  );
}
