'use client';

import {
  CalendarClock,
  Download,
  FileText,
  Loader2,
  Link2,
  RefreshCw,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ADMIN_REPORT_TYPE_DESCRIPTIONS,
  ADMIN_REPORT_TYPES,
  ADMIN_REPORT_CADENCES,
  ADMIN_REPORT_TYPE_LABELS,
  ADMIN_REPORT_CADENCE_LABELS,
  ADMIN_REPORT_MAX_RETENTION_DAYS,
  adminReportStatusBadgeClass,
  describeAdminReportFilters,
  formatAdminReportBytes,
  formatAdminReportCadence,
  formatAdminReportRowCount,
  formatAdminReportStatus,
  formatAdminReportType,
  validateAdminReportJobInput,
  validateAdminReportScheduleInput,
} from '@/lib/admin-reports';
import {
  ApiClientError,
  createAdminReportJob,
  createAdminReportSchedule,
  deleteAdminReportSchedule,
  fetchAdminReportJobs,
  fetchAdminReportSchedules,
  fetchAdminReportSignedUrl,
  runAdminReportSchedule,
  updateAdminReportSchedule,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminReportCadence,
  AdminReportFilterStatus,
  AdminReportJobRow,
  AdminReportScheduleRow,
  AdminReportType,
} from '@/types/files';

const POLL_INTERVAL_MS = 2_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError ? err.message : fallback;
}

export function AdminReportsSection() {
  const [jobs, setJobs] = useState<AdminReportJobRow[]>([]);
  const [schedules, setSchedules] = useState<AdminReportScheduleRow[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [reportType, setReportType] = useState<AdminReportType>('user_activity');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'' | AdminReportFilterStatus>('');
  const [actorEmail, setActorEmail] = useState('');
  const [targetId, setTargetId] = useState('');
  const [actionPrefix, setActionPrefix] = useState('');
  const [creating, setCreating] = useState(false);

  const [scheduleName, setScheduleName] = useState('');
  const [scheduleType, setScheduleType] =
    useState<AdminReportType>('users_and_guests');
  const [scheduleCadence, setScheduleCadence] =
    useState<AdminReportCadence>('weekly');
  const [scheduleRetentionDays, setScheduleRetentionDays] = useState('30');
  const [scheduleFrom, setScheduleFrom] = useState('');
  const [scheduleTo, setScheduleTo] = useState('');
  const [scheduleStatus, setScheduleStatus] = useState<
    '' | AdminReportFilterStatus
  >('');
  const [scheduleActorEmail, setScheduleActorEmail] = useState('');
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [busyScheduleId, setBusyScheduleId] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  const loadJobs = useCallback(async (silent = false) => {
    if (!silent) setJobsLoading(true);
    try {
      const response = await fetchAdminReportJobs(50);
      setJobs(response.jobs);
    } catch (err) {
      setError(
        errorMessage(err, '非同期レポートの履歴を読み込めませんでした。')
      );
    } finally {
      if (!silent) setJobsLoading(false);
    }
  }, []);

  const loadSchedules = useCallback(async () => {
    setSchedulesLoading(true);
    try {
      const response = await fetchAdminReportSchedules();
      setSchedules(response.schedules);
    } catch (err) {
      setError(errorMessage(err, '定期レポート設定を読み込めませんでした。'));
    } finally {
      setSchedulesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    void loadSchedules();
  }, [loadJobs, loadSchedules]);

  const hasActiveJob = jobs.some(
    (job) => job.status === 'queued' || job.status === 'running'
  );

  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setTimeout(() => {
      void loadJobs(true);
    }, POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [hasActiveJob, jobs, loadJobs]);

  async function handleCreateJob(event: React.FormEvent) {
    event.preventDefault();
    if (creating) return;
    setError(null);
    setNotice(null);
    const validation = validateAdminReportJobInput({
      reportType,
      from,
      to,
      status,
      actorEmail,
      targetId,
      actionPrefix,
    });
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setCreating(true);
    try {
      const response = await createAdminReportJob({
        reportType: validation.value.reportType,
        filters: validation.value.filters,
      });
      setNotice(
        `${formatAdminReportType(response.job.reportType)} の生成をキューに登録しました。完了まで自動更新します。`
      );
      await loadJobs(true);
    } catch (err) {
      setError(errorMessage(err, '非同期レポートの作成に失敗しました。'));
    } finally {
      setCreating(false);
    }
  }

  async function handleDownloadSignedUrl(job: AdminReportJobRow) {
    if (busyJobId) return;
    setBusyJobId(job.id);
    setError(null);
    try {
      const response = await fetchAdminReportSignedUrl(job.id);
      const anchor = document.createElement('a');
      anchor.href = response.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.click();
    } catch (err) {
      setError(
        errorMessage(err, '署名付きダウンロード URL の発行に失敗しました。')
      );
    } finally {
      setBusyJobId(null);
    }
  }

  async function handleCreateSchedule(event: React.FormEvent) {
    event.preventDefault();
    if (scheduleSaving) return;
    setError(null);
    setNotice(null);
    const validation = validateAdminReportScheduleInput({
      name: scheduleName,
      reportType: scheduleType,
      cadence: scheduleCadence,
      retentionDays: scheduleRetentionDays,
      from: scheduleFrom,
      to: scheduleTo,
      status: scheduleStatus,
      actorEmail: scheduleActorEmail,
    });
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setScheduleSaving(true);
    try {
      const response = await createAdminReportSchedule({
        name: validation.value.name,
        reportType: validation.value.reportType,
        cadence: validation.value.cadence,
        retentionDays: validation.value.retentionDays,
        filters: validation.value.filters,
      });
      setSchedules((prev) => [response.schedule, ...prev]);
      setScheduleName('');
      setNotice(
        `定期レポート「${response.schedule.name}」を保存しました（${formatAdminReportCadence(response.schedule.cadence)}）。`
      );
    } catch (err) {
      setError(errorMessage(err, '定期レポート設定の保存に失敗しました。'));
    } finally {
      setScheduleSaving(false);
    }
  }

  async function handleToggleSchedule(schedule: AdminReportScheduleRow) {
    if (busyScheduleId) return;
    setBusyScheduleId(schedule.id);
    setError(null);
    try {
      const response = await updateAdminReportSchedule(schedule.id, {
        enabled: !schedule.enabled,
      });
      setSchedules((prev) =>
        prev.map((row) => (row.id === schedule.id ? response.schedule : row))
      );
      setNotice(
        `「${schedule.name}」を${response.schedule.enabled ? '有効' : '無効'}にしました。`
      );
    } catch (err) {
      setError(errorMessage(err, '定期レポート設定の更新に失敗しました。'));
    } finally {
      setBusyScheduleId(null);
    }
  }

  async function handleRunSchedule(schedule: AdminReportScheduleRow) {
    if (busyScheduleId) return;
    setBusyScheduleId(schedule.id);
    setError(null);
    setNotice(null);
    try {
      await runAdminReportSchedule(schedule.id);
      setNotice(`「${schedule.name}」の即時テスト実行をキューに登録しました。`);
      await Promise.all([loadJobs(true), loadSchedules()]);
    } catch (err) {
      setError(errorMessage(err, '定期レポートの即時実行に失敗しました。'));
    } finally {
      setBusyScheduleId(null);
    }
  }

  async function handleDeleteSchedule(schedule: AdminReportScheduleRow) {
    if (busyScheduleId) return;
    setBusyScheduleId(schedule.id);
    setError(null);
    try {
      await deleteAdminReportSchedule(schedule.id);
      setSchedules((prev) => prev.filter((row) => row.id !== schedule.id));
      setNotice(`定期レポート「${schedule.name}」を削除しました。`);
    } catch (err) {
      setError(errorMessage(err, '定期レポート設定の削除に失敗しました。'));
    } finally {
      setBusyScheduleId(null);
    }
  }

  return (
    <section
      id="admin-reports"
      data-testid="admin-reports-section"
      aria-labelledby="admin-reports-heading"
      className="scroll-mt-6 space-y-4"
    >
      <div className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2
              id="admin-reports-heading"
              className="flex items-center gap-2 text-sm font-semibold text-slate-900"
            >
              <FileText className="h-4 w-4 text-[#5e6ad2]" />
              非同期レポート & 定期出力
            </h2>
            <p className="mt-1 text-[0.6875rem] text-slate-500">
              Queues / R2 で大規模 CSV を安全に生成し、期限付きでダウンロードできます。
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setError(null);
              void Promise.all([loadJobs(), loadSchedules()]);
            }}
            disabled={jobsLoading || schedulesLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                jobsLoading || schedulesLoading ? 'animate-spin' : ''
              }`}
            />
            <span>再読み込み</span>
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mx-5 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="mx-5 mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800"
          >
            {notice}
          </div>
        )}

        <form
          aria-label="非同期レポート作成フォーム"
          data-testid="admin-report-create-form"
          onSubmit={(event) => void handleCreateJob(event)}
          className="space-y-3 px-5 py-4"
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="text-[0.6875rem] font-medium text-slate-600">
              レポート種別
              <select
                data-testid="admin-report-type"
                value={reportType}
                onChange={(event) =>
                  setReportType(event.target.value as AdminReportType)
                }
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900"
              >
                {ADMIN_REPORT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ADMIN_REPORT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              開始日 (from)
              <input
                data-testid="admin-report-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              終了日 (to)
              <input
                data-testid="admin-report-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              結果
              <select
                data-testid="admin-report-status"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as '' | AdminReportFilterStatus)
                }
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              >
                <option value="">すべての結果</option>
                <option value="allowed">allowed のみ</option>
                <option value="blocked">blocked のみ</option>
              </select>
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              操作者メール
              <input
                data-testid="admin-report-actor-email"
                type="email"
                autoComplete="off"
                value={actorEmail}
                onChange={(event) => setActorEmail(event.target.value)}
                placeholder="user@example.com"
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              対象 ID
              <input
                data-testid="admin-report-target-id"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                placeholder="file / folder / user ID"
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              アクションプレフィックス
              <input
                data-testid="admin-report-action-prefix"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={actionPrefix}
                onChange={(event) => setActionPrefix(event.target.value)}
                placeholder="例: file., shared_link."
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <div className="flex items-end">
              <button
                type="submit"
                data-testid="admin-report-submit"
                disabled={creating}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#5e6ad2] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>レポートを生成</span>
              </button>
            </div>
          </div>
          <p className="text-[0.625rem] text-slate-500">
            {ADMIN_REPORT_TYPE_DESCRIPTIONS[reportType]}
          </p>
        </form>
      </div>

      <div className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
          <h3 className="text-xs font-semibold text-slate-900">
            生成ジョブ履歴
          </h3>
          <span className="text-[0.625rem] text-slate-500">
            最大 {formatAdminReportRowCount(10000)}・200 行ずつチャンク生成
          </span>
        </div>
        <div
          role="region"
          aria-label="非同期レポート生成ジョブ履歴"
          tabIndex={0}
          className="overflow-x-auto"
        >
          <table className="w-full text-left text-xs">
            <caption className="sr-only">非同期レポート生成ジョブ履歴</caption>
            <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2.5">種別</th>
                <th scope="col" className="px-4 py-2.5">ステータス</th>
                <th scope="col" className="px-4 py-2.5">条件</th>
                <th scope="col" className="px-4 py-2.5">行数</th>
                <th scope="col" className="px-4 py-2.5">サイズ</th>
                <th scope="col" className="px-4 py-2.5">更新</th>
                <th scope="col" className="px-4 py-2.5">作成日時</th>
                <th scope="col" className="px-4 py-2.5">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobsLoading && jobs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                    <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                    ジョブ履歴を読み込み中...
                  </td>
                </tr>
              )}
              {!jobsLoading && jobs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                    生成ジョブはまだありません。上のフォームから作成してください。
                  </td>
                </tr>
              )}
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  data-testid="admin-report-job-row"
                  data-job-id={job.id}
                  className="hover:bg-slate-50/70"
                >
                  <td className="px-4 py-2.5 font-medium text-slate-900">
                    {formatAdminReportType(job.reportType)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      data-testid="admin-report-job-status"
                      data-status={job.status}
                      className={`rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${adminReportStatusBadgeClass(
                        job.status
                      )}`}
                    >
                      {formatAdminReportStatus(job.status)}
                    </span>
                    {job.errorMessage && (
                      <p className="mt-1 max-w-xs text-[0.625rem] text-red-600">
                        {job.errorMessage}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-[0.6875rem] text-slate-600">
                    {describeAdminReportFilters(job.filters)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-700">
                    {job.rowCount.toLocaleString('ja-JP')}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-700">
                    {formatAdminReportBytes(job.byteSize)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${
                        job.scheduleId
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {job.scheduleId ? (
                        <CalendarClock className="h-3 w-3" />
                      ) : (
                        <Link2 className="h-3 w-3" />
                      )}
                      {job.scheduleId ? '自動 (定期)' : '手動'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-[0.6875rem] text-slate-600">
                    {formatAuditDateTime(job.createdAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    {job.status === 'completed' ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          data-testid="admin-report-job-download"
                          href={
                            job.downloadUrl ??
                            `/api/admin/reports/jobs/${job.id}/download`
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Download className="h-3 w-3" />
                          CSV ダウンロード
                        </a>
                        <button
                          type="button"
                          onClick={() => void handleDownloadSignedUrl(job)}
                          disabled={busyJobId === job.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[0.6875rem] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {busyJobId === job.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ExternalLink className="h-3 w-3" />
                          )}
                          署名 URL
                        </button>
                      </div>
                    ) : (
                      <span className="text-[0.6875rem] text-slate-400">
                        {job.status === 'failed' ? '再試行してください' : '生成完了後に有効'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
        <div className="border-b border-slate-200 px-5 py-3">
          <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-900">
            <CalendarClock className="h-4 w-4 text-[#5e6ad2]" />
            定期レポートスケジュール
          </h3>
          <p className="mt-1 text-[0.625rem] text-slate-500">
            毎日 03:00 UTC の Cron が due なスケジュールを Queue に投入し、
            保存期間を過ぎた R2 CSV を自動削除します。
          </p>
        </div>

        <form
          aria-label="定期レポートスケジュール作成フォーム"
          data-testid="admin-report-schedule-form"
          onSubmit={(event) => void handleCreateSchedule(event)}
          className="space-y-3 border-b border-slate-100 px-5 py-4"
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="text-[0.6875rem] font-medium text-slate-600">
              スケジュール名
              <input
                data-testid="admin-report-schedule-name"
                type="text"
                value={scheduleName}
                onChange={(event) => setScheduleName(event.target.value)}
                placeholder="例: 週次ユーザーアクティビティ"
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              定期レポート種別
              <select
                data-testid="admin-report-schedule-type"
                value={scheduleType}
                onChange={(event) =>
                  setScheduleType(event.target.value as AdminReportType)
                }
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              >
                {ADMIN_REPORT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ADMIN_REPORT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              定期実行頻度
              <select
                data-testid="admin-report-schedule-cadence"
                value={scheduleCadence}
                onChange={(event) =>
                  setScheduleCadence(event.target.value as AdminReportCadence)
                }
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              >
                {ADMIN_REPORT_CADENCES.map((cadence) => (
                  <option key={cadence} value={cadence}>
                    {ADMIN_REPORT_CADENCE_LABELS[cadence]}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              保存期間 (日)
              <input
                data-testid="admin-report-schedule-retention"
                type="number"
                min={1}
                max={ADMIN_REPORT_MAX_RETENTION_DAYS}
                value={scheduleRetentionDays}
                onChange={(event) =>
                  setScheduleRetentionDays(event.target.value)
                }
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              定期開始日 (from)
              <input
                data-testid="admin-report-schedule-from"
                type="date"
                value={scheduleFrom}
                onChange={(event) => setScheduleFrom(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              定期終了日 (to)
              <input
                data-testid="admin-report-schedule-to"
                type="date"
                value={scheduleTo}
                onChange={(event) => setScheduleTo(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              定期の結果
              <select
                value={scheduleStatus}
                onChange={(event) =>
                  setScheduleStatus(
                    event.target.value as '' | AdminReportFilterStatus
                  )
                }
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              >
                <option value="">すべての結果</option>
                <option value="allowed">allowed のみ</option>
                <option value="blocked">blocked のみ</option>
              </select>
            </label>

            <label className="text-[0.6875rem] font-medium text-slate-600">
              定期の操作者メール
              <input
                type="email"
                autoComplete="off"
                value={scheduleActorEmail}
                onChange={(event) => setScheduleActorEmail(event.target.value)}
                placeholder="user@example.com"
                className="mt-1 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              />
            </label>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="admin-report-schedule-submit"
              disabled={scheduleSaving}
              className="inline-flex items-center gap-2 rounded-lg border border-[#5e6ad2] bg-white px-3 py-1.5 text-xs font-medium text-[#5e6ad2] hover:bg-indigo-50 disabled:opacity-50"
            >
              {scheduleSaving && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              <span>スケジュールを保存</span>
            </button>
          </div>
        </form>

        <div
          role="region"
          aria-label="定期レポートスケジュール一覧"
          tabIndex={0}
          className="overflow-x-auto"
        >
          <table className="w-full text-left text-xs">
            <caption className="sr-only">定期レポートスケジュール一覧</caption>
            <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2.5">有効</th>
                <th scope="col" className="px-4 py-2.5">名前</th>
                <th scope="col" className="px-4 py-2.5">種別</th>
                <th scope="col" className="px-4 py-2.5">頻度</th>
                <th scope="col" className="px-4 py-2.5">次回</th>
                <th scope="col" className="px-4 py-2.5">最終実行</th>
                <th scope="col" className="px-4 py-2.5">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {schedulesLoading && schedules.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                    <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                    スケジュールを読み込み中...
                  </td>
                </tr>
              )}
              {!schedulesLoading && schedules.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                    定期レポートはまだありません。
                  </td>
                </tr>
              )}
              {schedules.map((schedule) => (
                <tr
                  key={schedule.id}
                  data-testid="admin-report-schedule-row"
                  data-schedule-id={schedule.id}
                  className="hover:bg-slate-50/70"
                >
                  <td className="px-4 py-2.5">
                    <input
                      data-testid="admin-report-schedule-toggle"
                      type="checkbox"
                      aria-label={`${schedule.name} を有効化`}
                      checked={schedule.enabled}
                      disabled={busyScheduleId === schedule.id}
                      onChange={() => void handleToggleSchedule(schedule)}
                      className="h-4 w-4 rounded border-slate-300 text-[#5e6ad2]"
                    />
                  </td>
                  <td className="px-4 py-2.5 font-medium text-slate-900">
                    {schedule.name}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {formatAdminReportType(schedule.reportType)}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {formatAdminReportCadence(schedule.cadence)}
                    <span className="ml-1 text-[0.625rem] text-slate-400">
                      / 保存 {schedule.retentionDays} 日
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-[0.6875rem] text-slate-600">
                    {formatAuditDateTime(schedule.nextRunAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-[0.6875rem] text-slate-600">
                    {schedule.lastRunAt
                      ? formatAuditDateTime(schedule.lastRunAt)
                      : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRunSchedule(schedule)}
                        disabled={busyScheduleId === schedule.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {busyScheduleId === schedule.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        即時実行
                      </button>
                      <button
                        type="button"
                        aria-label={`${schedule.name} を削除`}
                        onClick={() => void handleDeleteSchedule(schedule)}
                        disabled={busyScheduleId === schedule.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-[0.6875rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
