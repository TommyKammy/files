'use client';

import { useEffect, useState } from 'react';
import {
  ApiClientError,
  createSharedLink,
  listSharedLinks,
  revokeSharedLink,
} from '@/lib/files-api';
import type {
  ClassificationLabel,
  ShareAccessScope,
  SharedLinkSummary,
} from '@/types/files';

export function useSharePopover({
  targetType,
  targetId,
  classification,
  canEdit,
}: {
  targetType: 'file' | 'folder';
  targetId: string;
  classification: ClassificationLabel;
  canEdit: boolean;
}) {
  const publicRestricted =
    classification === 'confidential' || classification === 'unset';

  const [links, setLinks] = useState<SharedLinkSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessScope, setAccessScope] = useState<ShareAccessScope>(
    publicRestricted ? 'company_only' : 'public'
  );
  const [canDownload, setCanDownload] = useState(true);
  const [requireWatermark, setRequireWatermark] = useState(
    classification === 'confidential'
  );
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(
    classification === 'confidential' ? 7 : 30
  );
  const [maxDownloads, setMaxDownloads] = useState('');
  const [creating, setCreating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  async function reloadLinks() {
    setLoading(true);
    setError(null);
    try {
      const res = await listSharedLinks(targetType, targetId);
      setLinks(res.links);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '共有リンクの取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reloadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetType, targetId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || creating) return;
    setCreating(true);
    setError(null);
    setGeneratedUrl(null);

    try {
      const parsedMaxDownloads = maxDownloads.trim()
        ? Number.parseInt(maxDownloads.trim(), 10)
        : undefined;

      const res = await createSharedLink({
        targetType,
        targetId,
        accessScope,
        canDownload,
        requireWatermark,
        password: password.trim() || undefined,
        expiresInDays,
        maxDownloads:
          parsedMaxDownloads && parsedMaxDownloads > 0
            ? parsedMaxDownloads
            : undefined,
      });

      const fullUrl =
        typeof window !== 'undefined'
          ? `${window.location.origin}${res.shareUrl}`
          : res.shareUrl;
      setGeneratedUrl(fullUrl);
      setPassword('');
      await reloadLinks();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '共有リンクの作成に失敗しました'
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(linkId: string) {
    setError(null);
    try {
      await revokeSharedLink(linkId);
      await reloadLinks();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '共有リンクの無効化に失敗しました'
      );
    }
  }

  return {
    publicRestricted,
    links,
    loading,
    error,
    accessScope,
    setAccessScope,
    canDownload,
    setCanDownload,
    requireWatermark,
    setRequireWatermark,
    password,
    setPassword,
    showPassword,
    setShowPassword,
    expiresInDays,
    setExpiresInDays,
    maxDownloads,
    setMaxDownloads,
    creating,
    generatedUrl,
    handleCreate,
    handleRevoke,
  };
}
