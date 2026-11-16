'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  PreResolvedPreviewGrant,
  PreviewTargetFile,
} from '@/components/SecurePreviewModal';
import {
  ApiClientError,
  getPublicShareMeta,
  issuePublicShareUrl,
  verifyPublicSharePassword,
} from '@/lib/files-api';
import type {
  PublicShareFileMeta,
  PublicShareMeta,
} from '@/types/files';

export function useSharedLinkLanding(token: string) {
  const [meta, setMeta] = useState<PublicShareMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [verifyingPassword, setVerifyingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlockToken, setUnlockToken] = useState<string | undefined>(
    undefined
  );

  const [previewState, setPreviewState] = useState<{
    file: PreviewTargetFile;
    grant: PreResolvedPreviewGrant;
  } | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const data = await getPublicShareMeta(token);
      setMeta(data);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorCode(err.code ?? String(err.status));
        setErrorMessage(err.message);
      } else {
        setErrorCode('LOAD_ERROR');
        setErrorMessage('共有リンクの読み込みに失敗しました');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  async function handleVerifyPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!password || verifyingPassword) return;
    setVerifyingPassword(true);
    setPasswordError(null);
    try {
      const res = await verifyPublicSharePassword(token, password);
      if (res.unlockToken) {
        setUnlockToken(res.unlockToken);
      }
      setPassword('');
      await loadMeta();
    } catch (err) {
      if (err instanceof ApiClientError) {
        const remaining =
          typeof err.details?.remainingAttempts === 'number'
            ? ` (残り試行回数: ${err.details.remainingAttempts})`
            : '';
        setPasswordError(`${err.message}${remaining}`);
        if (err.code === 'LINK_LOCKED') {
          await loadMeta();
        }
      } else {
        setPasswordError('パスワード検証に失敗しました');
      }
    } finally {
      setVerifyingPassword(false);
    }
  }

  async function handlePreview(file: PublicShareFileMeta) {
    if (actionBusyId) return;
    setActionBusyId(file.id);
    setErrorMessage(null);
    try {
      const granted = await issuePublicShareUrl(token, {
        intent: 'preview',
        fileId: file.id,
        unlockToken,
      });
      setPreviewState({
        file: {
          id: granted.file.id,
          name: granted.file.name,
          mimeType: granted.file.mimeType,
          sizeBytes: granted.file.sizeBytes,
          classification: granted.file.classification,
        },
        grant: {
          url: granted.url,
          safeRenderMode: granted.safeRenderMode,
          requireWatermark: granted.requireWatermark,
          watermarkText: granted.watermarkText,
        },
      });
    } catch (err) {
      setErrorMessage(
        err instanceof ApiClientError
          ? err.message
          : 'プレビューURLの発行に失敗しました'
      );
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleDownload(file: PublicShareFileMeta) {
    if (!meta?.canDownload || actionBusyId) return;
    setActionBusyId(file.id);
    setErrorMessage(null);
    try {
      const granted = await issuePublicShareUrl(token, {
        intent: 'download',
        fileId: file.id,
        unlockToken,
      });
      setMeta((prev) =>
        prev ? { ...prev, downloadCount: granted.downloadCount } : prev
      );
      window.open(granted.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setErrorMessage(
        err instanceof ApiClientError
          ? err.message
          : 'ダウンロードURLの発行に失敗しました'
      );
    } finally {
      setActionBusyId(null);
    }
  }

  return {
    meta,
    loading,
    errorCode,
    errorMessage,
    password,
    setPassword,
    showPassword,
    setShowPassword,
    verifyingPassword,
    passwordError,
    previewState,
    setPreviewState,
    actionBusyId,
    handleVerifyPassword,
    handlePreview,
    handleDownload,
  };
}
