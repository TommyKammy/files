'use client';

import { useCallback, useState } from 'react';
import { ApiClientError, listTrash } from '@/lib/files-api';
import type { FileItem, FolderSummary } from '@/types/files';

export function useWorkspaceTrash({
  setError,
}: {
  setError: (message: string | null) => void;
}) {
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadTrash = useCallback(async () => {
    setLoading(true);
    try {
      const trash = await listTrash(100);
      setFolders(trash.folders);
      setFiles(trash.files);
      setLoaded(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'フォルダ内容の取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }, [setError]);

  const updateFile = useCallback((updated: FileItem) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === updated.id ? updated : f))
    );
  }, []);

  const removeFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
  }, []);

  const removeFile = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  return {
    folders,
    files,
    loading,
    loaded,
    loadTrash,
    updateFile,
    removeFolder,
    removeFile,
  };
}
