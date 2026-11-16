import type { ClassificationLabel } from '@/types/files';

export interface ParsedSearchQuery {
  filter: ClassificationLabel | null;
  textTokens: string[];
  isCommandMode: boolean;
}

const CLASSIFICATION_FILTER_MAP: Record<string, ClassificationLabel> = {
  'is:confidential': 'confidential',
  'is:internal': 'internal',
  'is:public': 'public',
  'is:unset': 'unset',
};

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const trimmedStart = rawQuery.trimStart();
  const isCommandMode = trimmedStart.startsWith('>');
  const body = isCommandMode ? trimmedStart.slice(1).trim() : trimmedStart.trim();
  if (!body) {
    return { filter: null, textTokens: [], isCommandMode };
  }

  let filter: ClassificationLabel | null = null;
  const textTokens: string[] = [];
  for (const part of body.toLowerCase().split(/\s+/)) {
    if (!part) continue;
    const mapped = !isCommandMode ? CLASSIFICATION_FILTER_MAP[part] : undefined;
    if (mapped) {
      filter = mapped;
    } else {
      textTokens.push(part);
    }
  }

  return { filter, textTokens, isCommandMode };
}

export function matchesLocalSearchItem(
  name: string,
  classification: ClassificationLabel,
  pathHint: string | null,
  parsed: ParsedSearchQuery
): boolean {
  if (parsed.isCommandMode) return false;
  if (parsed.filter && classification !== parsed.filter) {
    return false;
  }
  if (parsed.textTokens.length === 0) return true;
  const haystack = `${name} ${pathHint ?? ''} ${classification}`.toLowerCase();
  return parsed.textTokens.every((token) => haystack.includes(token));
}


