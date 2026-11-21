'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  getPublicFileRequestMeta,
  uploadToPublicFileRequest,
} from '@/lib/files-api';
import {
  mountTurnstileWidget,
  type TurnstileStatus,
  type TurnstileWidgetController,
} from '@/lib/turnstile';
import type { PublicFileRequestMeta } from '@/types/files';

export interface SubmittedRecord {
  id: string;
  fileName: string;
  sizeBytes: number;
  status: 'uploading' | 'done' | 'error';
  percent: number;
  submittedAt?: string;
  errorMessage?: string;
}

export function usePublicFileRequestUploader({ token }: { token: string }) {
  const [meta, setMeta] = useState<PublicFileRequestMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [submitterEmail, setSubmitterEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileStatus, setTurnstileStatus] = useState<TurnstileStatus>('idle');
  const [turnstileError, setTurnstileError] = useState<string | null>(null);
  const [turnstileMountSeq, setTurnstileMountSeq] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [submissions, setSubmissions] = useState<SubmittedRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileControllerRef = useRef<TurnstileWidgetController | null>(null);

  const turnstileSiteKey = meta?.turnstileSiteKey?.trim() || null;
  const usesTurnstileWidget = Boolean(meta?.turnstileEnabled && turnstileSiteKey);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    getPublicFileRequestMeta(token)
      .then((res) => setMeta(res))
      .catch((err) => {
        setLoadError(
          err instanceof ApiClientError
            ? err.message
            : 'ファイル収集リンクの読み込みに失敗しました'
        );
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (!usesTurnstileWidget || !turnstileSiteKey || !turnstileContainerRef.current) {
      turnstileControllerRef.current = null;
      return;
    }

    const controller = mountTurnstileWidget({
      container: turnstileContainerRef.current,
      siteKey: turnstileSiteKey,
      onTokenChange: setTurnstileToken,
      onStatusChange: setTurnstileStatus,
      onErrorChange: setTurnstileError,
    });
    turnstileControllerRef.current = controller;

    return () => {
      controller.remove();
      if (turnstileControllerRef.current === controller) {
        turnstileControllerRef.current = null;
      }
      setTurnstileToken('');
    };
  }, [usesTurnstileWidget, turnstileSiteKey, turnstileMountSeq]);

  function retryTurnstile() {
    if (turnstileControllerRef.current?.getWidgetId() !== null) {
      turnstileControllerRef.current?.reset();
      return;
    }
    setTurnstileToken('');
    setTurnstileMountSeq((n) => n + 1);
  }

  async function handleFiles(fileList: FileList | null) {
    if (!meta || !fileList || fileList.length === 0) return;
    // Capture the selection before the input is reset by the caller, because
    // state updaters may run later when the live FileList is already empty.
    const files = Array.from(fileList);
    const firstFile = files[0];
    if (!firstFile) return;

    if (meta.requireSubmitterEmail && !submitterEmail.trim()) {
      const errorRecord: SubmittedRecord = {
        id: crypto.randomUUID(),
        fileName: firstFile.name,
        sizeBytes: firstFile.size,
        status: 'error',
        percent: 0,
        errorMessage: '送信前にメールアドレスを入力してください。',
      };
      setSubmissions((prev) => [errorRecord, ...prev]);
      return;
    }

    if (meta.turnstileEnabled && !turnstileToken.trim()) {
      const errorRecord: SubmittedRecord = {
        id: crypto.randomUUID(),
        fileName: firstFile.name,
        sizeBytes: firstFile.size,
        status: 'error',
        percent: 0,
        errorMessage: '送信前に Turnstile 認証を完了してください。',
      };
      setSubmissions((prev) => [errorRecord, ...prev]);
      return;
    }

    for (const file of files) {
      const recId = crypto.randomUUID();
      setSubmissions((prev) => [
        {
          id: recId,
          fileName: file.name,
          sizeBytes: file.size,
          status: 'uploading',
          percent: 0,
        },
        ...prev,
      ]);

      try {
        const res = await uploadToPublicFileRequest({
          token,
          file,
          submitterEmail,
          turnstileToken: meta.turnstileEnabled ? turnstileToken : undefined,
          onProgress: (percent) => {
            setSubmissions((prev) =>
              prev.map((s) => (s.id === recId ? { ...s, percent } : s))
            );
          },
        });
        setSubmissions((prev) =>
          prev.map((s) =>
            s.id === recId
              ? {
                  ...s,
                  status: 'done',
                  percent: 100,
                  submittedAt: res.submittedAt,
                }
              : s
          )
        );
      } catch (err) {
        setSubmissions((prev) =>
          prev.map((s) =>
            s.id === recId
              ? {
                  ...s,
                  status: 'error',
                  errorMessage:
                    err instanceof ApiClientError
                      ? err.message
                      : 'ファイルのアップロードに失敗しました',
                }
              : s
          )
        );
      } finally {
        if (meta.turnstileEnabled) {
          if (usesTurnstileWidget) {
            turnstileControllerRef.current?.reset();
          } else {
            setTurnstileToken('');
          }
        }
      }
    }
  }

  return {
    meta,
    loading,
    loadError,
    submitterEmail,
    setSubmitterEmail,
    turnstileToken,
    setTurnstileToken,
    turnstileStatus,
    turnstileError,
    usesTurnstileWidget,
    turnstileContainerRef,
    retryTurnstile,
    dragging,
    setDragging,
    submissions,
    fileInputRef,
    handleFiles,
  };
}
