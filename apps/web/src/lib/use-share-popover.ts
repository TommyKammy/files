'use client';

import { useEffect, useState } from 'react';
import {
  ApiClientError,
  createSharedLink,
  listSharedLinks,
  revokeSharedLink,
  updateSharedLink,
} from '@/lib/files-api';
import {
  defaultSharePermissionLevel,
  permissionLevelCanDownload,
  validateShareLinkForm,
} from '@/lib/share-link-levels';
import type {
  ClassificationLabel,
  ShareAccessScope,
  SharePermissionLevel,
  SharedLinkSummary,
  TenantPolicyRow,
  UpdateSharedLinkPayload,
} from '@/types/files';

type SharePolicyLike =
  | Pick<
      TenantPolicyRow,
      | 'allowSharedLinkEdit'
      | 'allowPublicEditLinks'
      | 'allowViewerShareLinks'
      | 'allow_shared_link_edit'
      | 'allow_public_edit_links'
      | 'allow_viewer_share_links'
    >
  | null
  | undefined;

function readPolicyFlag(
  policy: SharePolicyLike,
  camel:
    | 'allowSharedLinkEdit'
    | 'allowPublicEditLinks'
    | 'allowViewerShareLinks',
  snake:
    | 'allow_shared_link_edit'
    | 'allow_public_edit_links'
    | 'allow_viewer_share_links'
): boolean {
  const camelValue = policy?.[camel];
  if (typeof camelValue === 'boolean') return camelValue;
  return policy?.[snake] === 1;
}

export function useSharePopover({
  targetType,
  targetId,
  classification,
  canEdit,
  canManageLinks = canEdit,
  policy = null,
}: {
  targetType: 'file' | 'folder';
  targetId: string;
  classification: ClassificationLabel;
  canEdit: boolean;
  canManageLinks?: boolean;
  policy?: SharePolicyLike;
}) {
  const publicRestricted =
    classification === 'confidential' || classification === 'unset';
  const allowSharedLinkEdit = readPolicyFlag(
    policy,
    'allowSharedLinkEdit',
    'allow_shared_link_edit'
  );
  const allowPublicEditLinks = readPolicyFlag(
    policy,
    'allowPublicEditLinks',
    'allow_public_edit_links'
  );
  const allowViewerShareLinks = readPolicyFlag(
    policy,
    'allowViewerShareLinks',
    'allow_viewer_share_links'
  );

  const [links, setLinks] = useState<SharedLinkSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessScope, setAccessScope] = useState<ShareAccessScope>(
    publicRestricted ? 'company_only' : 'public'
  );
  const [permissionLevel, setPermissionLevel] = useState<SharePermissionLevel>(
    defaultSharePermissionLevel({ canManageLinks, classification })
  );
  const [requireWatermark, setRequireWatermark] = useState(
    classification === 'confidential' || !canManageLinks
  );
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(
    classification === 'confidential' ? 7 : 30
  );
  const [maxDownloads, setMaxDownloads] = useState('');
  const [creating, setCreating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [updatingLinkId, setUpdatingLinkId] = useState<string | null>(null);

  const viewerViewOnly = !canManageLinks;
  const confidentialFloor = classification === 'confidential';
  const canSelectDownload = canManageLinks && !confidentialFloor;
  const canSelectEdit =
    canManageLinks && allowSharedLinkEdit && !confidentialFloor;
  const canDownload = permissionLevelCanDownload(permissionLevel) && canManageLinks;

  useEffect(() => {
    setPermissionLevel(
      defaultSharePermissionLevel({ canManageLinks, classification })
    );
  }, [canManageLinks, classification]);

  async function reloadLinks() {
    if (!canManageLinks) {
      setLinks([]);
      setLoading(false);
      return;
    }
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

    const validationError = validateShareLinkForm({
      permissionLevel,
      accessScope,
      canManageLinks,
      allowSharedLinkEdit,
      allowPublicEditLinks,
      password,
      expiresInDays,
    });
    if (validationError) {
      setError(validationError);
      return;
    }

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
        permissionLevel,
        canDownload,
        requireWatermark:
          classification === 'confidential' ||
          !canManageLinks ||
          permissionLevel === 'edit'
            ? true
            : requireWatermark,
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
    if (!canManageLinks) return;
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

  async function handleUpdateLevel(
    linkId: string,
    nextLevel: SharePermissionLevel
  ) {
    if (!canManageLinks) return;
    setUpdatingLinkId(linkId);
    setError(null);
    try {
      await updateSharedLink(linkId, { permissionLevel: nextLevel });
      await reloadLinks();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '共有リンクの権限レベル更新に失敗しました'
      );
    } finally {
      setUpdatingLinkId(null);
    }
  }

  async function handleUpdateSettings(
    linkId: string,
    payload: UpdateSharedLinkPayload
  ): Promise<boolean> {
    if (!canManageLinks) return false;
    setUpdatingLinkId(linkId);
    setError(null);
    try {
      await updateSharedLink(linkId, payload);
      await reloadLinks();
      return true;
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '共有リンクの設定更新に失敗しました'
      );
      return false;
    } finally {
      setUpdatingLinkId(null);
    }
  }

  return {
    publicRestricted,
    allowSharedLinkEdit,
    allowPublicEditLinks,
    allowViewerShareLinks,
    viewerViewOnly,
    canSelectDownload,
    canSelectEdit,
    links,
    loading,
    error,
    accessScope,
    setAccessScope,
    permissionLevel,
    setPermissionLevel,
    canDownload,
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
    updatingLinkId,
    generatedUrl,
    handleCreate,
    handleRevoke,
    handleUpdateLevel,
    handleUpdateSettings,
  };
}
