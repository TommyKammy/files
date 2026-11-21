import { apiFetch } from './core';

export type ItemTargetType = 'file' | 'folder';
export type InspectorTab = 'details' | 'comments' | 'activity';

export const MAX_COMMENT_LENGTH = 2000;

export interface ItemComment {
  id: string;
  itemType: ItemTargetType;
  itemId: string;
  authorId: string;
  authorDisplayName: string;
  authorEmail: string | null;
  body: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CommentsListResponse {
  comments: ItemComment[];
  total: number;
  limit: number;
  offset: number;
}

export interface CommentMutationResponse {
  comment: ItemComment;
  mentionedUserIds: string[];
}

export interface ItemActivityEntry {
  id: string;
  actorDisplayName: string;
  action: string;
  actionLabel: string;
  status: 'allowed' | 'blocked' | string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface ActivityListResponse {
  activities: ItemActivityEntry[];
}

export interface MentionSegment {
  text: string;
  isMention: boolean;
}

const MENTION_SEGMENT_REGEX =
  /(^|[\s(「『【\[,;])(@[a-zA-Z0-9._%+-]+(?:@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})?)/g;

/**
 * Split comment body into plain-text and @mention segments so UI can render
 * highlighted mentions with React elements instead of dangerouslySetInnerHTML.
 */
export function parseMentionSegments(body: string): MentionSegment[] {
  if (!body) return [];
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  MENTION_SEGMENT_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_SEGMENT_REGEX.exec(body)) !== null) {
    const prefix = match[1] ?? '';
    const mention = match[2] ?? '';
    const mentionStart = match.index + prefix.length;
    if (mentionStart > lastIndex) {
      segments.push({
        text: body.slice(lastIndex, mentionStart),
        isMention: false,
      });
    }
    segments.push({
      text: mention,
      isMention: true,
    });
    lastIndex = mentionStart + mention.length;
  }

  if (lastIndex < body.length) {
    segments.push({
      text: body.slice(lastIndex),
      isMention: false,
    });
  }
  return segments;
}

export function validateCommentBody(
  raw: string
): { valid: true; body: string } | { valid: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'コメントを入力してください。' };
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return {
      valid: false,
      error: `コメントは ${MAX_COMMENT_LENGTH} 文字以内で入力してください。`,
    };
  }
  return { valid: true, body: trimmed };
}

export function listItemComments(
  itemType: ItemTargetType,
  itemId: string,
  opts?: { limit?: number; offset?: number },
  signal?: AbortSignal
): Promise<CommentsListResponse> {
  const params = new URLSearchParams();
  if (typeof opts?.limit === 'number') {
    params.set('limit', String(opts.limit));
  }
  if (typeof opts?.offset === 'number') {
    params.set('offset', String(opts.offset));
  }
  const qs = params.toString();
  return apiFetch(
    `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/comments${qs ? `?${qs}` : ''}`,
    { signal }
  );
}

export function createItemComment(
  itemType: ItemTargetType,
  itemId: string,
  body: string
): Promise<CommentMutationResponse> {
  return apiFetch(
    `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ body }),
    }
  );
}

export function updateComment(
  commentId: string,
  body: string
): Promise<CommentMutationResponse> {
  return apiFetch(`/api/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

export function deleteComment(
  commentId: string
): Promise<{ ok: boolean; id: string }> {
  return apiFetch(`/api/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
}

export function listItemActivity(
  itemType: ItemTargetType,
  itemId: string,
  signal?: AbortSignal
): Promise<ActivityListResponse> {
  return apiFetch(
    `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/activity`,
    { signal }
  );
}
