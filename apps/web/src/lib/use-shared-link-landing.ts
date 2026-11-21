'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  PreResolvedPreviewGrant,
  PreviewTargetFile,
} from '@/components/SecurePreviewModal';
import {
  ApiClientError,
  createSharedLinkWopiSession,
  downloadPublicShareZip,
  getPublicShareMeta,
  issuePublicShareUrl,
  triggerBlobDownload,
  uploadViaSharedLink,
  verifyPublicSharePassword,
} from '@/lib/files-api';
import type {
  PublicShareFileMeta,
  PublicShareMeta,
  WopiSessionResponse,
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [wopiSession, setWopiSession] = useState<WopiSessionResponse | null>(null);
  const [wopiBusy, setWopiBusy] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const loadMeta = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const data = await getPublicShareMeta(token, currentFolderId);
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
  }, [token, currentFolderId]);

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

  async function handleUpload(
    file: File,
    options: { fileId?: string; conflictPolicy?: 'fail' | 'new_version' } = {}
  ) {
    if (!meta?.canEdit || uploading) return;
    setUploading(true);
    setUploadError(null);
    setUploadNotice(null);
    try {
      const result = await uploadViaSharedLink(token, {
        file: {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          body: file,
        },
        fileId: options.fileId,
        conflictPolicy: options.conflictPolicy ?? 'new_version',
        unlockToken,
      });
      setUploadNotice(
        `アップロードしました (v${result.version.versionNum})${
          result.version.versionNum > 1 ? ' — 新バージョンとして保存' : ''
        }`
      );
      await loadMeta();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setUploadError(
          err.code === 'FILE_LOCKED'
            ? 'このファイルは現在他のユーザーが編集中のため、アップロードできません（FILE_LOCKED）。'
            : err.message
        );
      } else {
        setUploadError(
          err instanceof Error
            ? err.message
            : 'アップロードに失敗しました'
        );
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleWopiEdit(file: PublicShareFileMeta) {
    if (!meta?.canEdit || wopiBusy) return;
    setWopiBusy(true);
    setUploadError(null);
    try {
      const session = await createSharedLinkWopiSession(token, {
        fileId: file.id,
        unlockToken,
      });
      setWopiSession(session);
    } catch (err) {
      setUploadError(
        err instanceof ApiClientError
          ? err.message
          : 'WOPI セッションの作成に失敗しました'
      );
    } finally {
      setWopiBusy(false);
    }
  }

  function navigateToFolder(folderId: string | null) {
    setCurrentFolderId(folderId);
  }

  async function handleDownloadZip() {
    if (!meta?.canDownload || meta.targetType !== 'folder' || downloadingZip) return;
    setDownloadingZip(true);
    setErrorMessage(null);
    try {
      const { blob, filename, downloadCount } = await downloadPublicShareZip(token, {
        folderId: currentFolderId,
        unlockToken,
      });
      if (downloadCount !== null) {
        setMeta((prev) => (prev ? { ...prev, downloadCount } : prev));
      }
      triggerBlobDownload(blob, filename);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiClientError
          ? err.message
          : 'ZIPダウンロードに失敗しました'
      );
    } finally {
      setDownloadingZip(false);
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
    uploading,
    uploadError,
    uploadNotice,
    wopiSession,
    setWopiSession,
    wopiBusy,
    currentFolderId,
    downloadingZip,
    navigateToFolder,
    handleDownloadZip,
    handleVerifyPassword,
    handlePreview,
    handleDownload,
    handleUpload,
    handleWopiEdit,
  };
}
