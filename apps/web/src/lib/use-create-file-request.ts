'use client';

import { useEffect, useState } from 'react';
import {
  ApiClientError,
  createFileRequest,
  deactivateFileRequest,
  listFileRequests,
} from '@/lib/files-api';
import type { FileRequestSummary } from '@/types/files';

export function useCreateFileRequest({
  folderId,
  folderName,
  canEdit,
}: {
  folderId: string;
  folderName: string;
  canEdit: boolean;
}) {
  const [requests, setRequests] = useState<FileRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(`${folderName} 資料回収ボックス`);
  const [description, setDescription] = useState('');
  const [requireSubmitterEmail, setRequireSubmitterEmail] = useState(true);
  const [maxSizeMiB, setMaxSizeMiB] = useState(50);
  const [allowedExtText, setAllowedExtText] = useState(
    'pdf, docx, xlsx, csv, png'
  );
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [creating, setCreating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await listFileRequests(folderId);
      setRequests(res.fileRequests);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ファイル収集ボックス一覧の取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || creating || !title.trim()) return;
    setCreating(true);
    setError(null);
    setGeneratedUrl(null);

    try {
      const allowedExtensions = allowedExtText
        .split(',')
        .map((s) => s.replace(/^\./, '').trim().toLowerCase())
        .filter(Boolean);

      const res = await createFileRequest({
        folderId,
        title: title.trim(),
        description: description.trim() || undefined,
        requireSubmitterEmail,
        maxFileSizeBytes: Math.max(1, maxSizeMiB) * 1024 * 1024,
        allowedExtensions:
          allowedExtensions.length > 0 ? allowedExtensions : undefined,
        expiresInDays: Math.max(1, expiresInDays),
      });

      const fullUrl =
        typeof window !== 'undefined'
          ? `${window.location.origin}${res.requestUrl}`
          : res.requestUrl;
      setGeneratedUrl(fullUrl);
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ファイル収集リクエストの作成に失敗しました'
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleDeactivate(id: string) {
    setError(null);
    try {
      await deactivateFileRequest(id);
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ファイル収集リクエストの停止に失敗しました'
      );
    }
  }

  return {
    requests,
    loading,
    error,
    title,
    setTitle,
    description,
    setDescription,
    requireSubmitterEmail,
    setRequireSubmitterEmail,
    maxSizeMiB,
    setMaxSizeMiB,
    allowedExtText,
    setAllowedExtText,
    expiresInDays,
    setExpiresInDays,
    creating,
    generatedUrl,
    handleCreate,
    handleDeactivate,
  };
}
