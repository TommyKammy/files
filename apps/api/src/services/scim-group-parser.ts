import type { ScimPatchOperationInput } from '../types/scim';
import { isRecord } from './scim-parser-shared';

export interface ScimGroupPatchUpdates {
  displayName?: string;
  externalIdpId?: string | null;
  replaceMembers?: string[];
  addMemberIds: string[];
  removeMemberIds: string[];
}

export function extractGroupMemberIds(rawValue: unknown): string[] {
  const entries = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim()) {
      ids.push(entry.trim());
    } else if (isRecord(entry) && typeof entry.value === 'string' && entry.value.trim()) {
      ids.push(entry.value.trim());
    }
  }
  return [...new Set(ids)];
}

/**
 * Parse SCIM Group PATCH `Operations`, including:
 * - `op: "Add" | "add"` / `"Replace" | "replace"` / `"Remove" | "remove"`
 * - path-omitted `{ displayName, members }`
 * - `members[value eq "<userId>"]` filter paths
 */
export function parseScimGroupPatch(raw: unknown): ScimGroupPatchUpdates {
  if (!isRecord(raw) || !Array.isArray(raw.Operations)) {
    throw new Error('SCIM Group PatchOp payload must contain an Operations array');
  }

  let displayName: string | undefined;
  let externalIdpId: string | null | undefined;
  let replaceMembers: string[] | undefined;
  const addSet = new Set<string>();
  const removeSet = new Set<string>();

  for (const item of raw.Operations as ScimPatchOperationInput[]) {
    if (!isRecord(item)) continue;
    const op = typeof item.op === 'string' ? item.op.trim().toLowerCase() : 'replace';
    const path = typeof item.path === 'string' ? item.path.trim() : '';

    if (!path) {
      if (isRecord(item.value)) {
        if (typeof item.value.displayName === 'string' && item.value.displayName.trim()) {
          displayName = item.value.displayName.trim();
        }
        if ('externalId' in item.value) {
          externalIdpId =
            typeof item.value.externalId === 'string' && item.value.externalId.trim()
              ? item.value.externalId.trim()
              : null;
        }
        if ('members' in item.value) {
          const ids = extractGroupMemberIds(item.value.members);
          if (op === 'remove') {
            for (const id of ids) {
              removeSet.add(id);
              addSet.delete(id);
            }
          } else if (op === 'add') {
            for (const id of ids) {
              addSet.add(id);
              removeSet.delete(id);
            }
          } else {
            replaceMembers = ids;
            addSet.clear();
            removeSet.clear();
          }
        }
      }
      continue;
    }

    const lowerPath = path.toLowerCase();
    if (lowerPath === 'displayname' && op !== 'remove' && typeof item.value === 'string') {
      const trimmed = item.value.trim();
      if (trimmed) displayName = trimmed;
      continue;
    }

    if (lowerPath === 'externalid') {
      externalIdpId =
        op === 'remove' || typeof item.value !== 'string' || !item.value.trim()
          ? null
          : item.value.trim();
      continue;
    }

    const memberFilterMatch = path.match(
      /^members\[\s*value\s+eq\s+(?:"([^"]+)"|'([^']+)')\s*\]$/i
    );
    if (memberFilterMatch) {
      const targetUserId = (memberFilterMatch[1] ?? memberFilterMatch[2] ?? '').trim();
      if (targetUserId && op === 'remove') {
        removeSet.add(targetUserId);
        addSet.delete(targetUserId);
      } else if (targetUserId && (op === 'add' || op === 'replace')) {
        addSet.add(targetUserId);
        removeSet.delete(targetUserId);
      }
      continue;
    }

    if (lowerPath === 'members') {
      if (op === 'remove') {
        const ids = extractGroupMemberIds(item.value);
        if (ids.length === 0 && item.value === undefined) {
          replaceMembers = [];
          addSet.clear();
          removeSet.clear();
        } else {
          for (const id of ids) {
            removeSet.add(id);
            addSet.delete(id);
            if (replaceMembers) {
              replaceMembers = replaceMembers.filter((existing) => existing !== id);
            }
          }
        }
      } else if (op === 'add') {
        for (const id of extractGroupMemberIds(item.value)) {
          addSet.add(id);
          removeSet.delete(id);
          if (replaceMembers && !replaceMembers.includes(id)) {
            replaceMembers.push(id);
          }
        }
      } else if (op === 'replace') {
        replaceMembers = extractGroupMemberIds(item.value);
        addSet.clear();
        removeSet.clear();
      }
    }
  }

  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(externalIdpId !== undefined ? { externalIdpId } : {}),
    ...(replaceMembers !== undefined ? { replaceMembers } : {}),
    addMemberIds: [...addSet],
    removeMemberIds: [...removeSet],
  };
}
