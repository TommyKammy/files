export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; label: string; href: string };

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: MarkdownInline[] }
  | { kind: 'paragraph'; inlines: MarkdownInline[] }
  | { kind: 'list'; ordered: boolean; items: MarkdownInline[][] }
  | { kind: 'blockquote'; inlines: MarkdownInline[] }
  | { kind: 'code'; language: string | null; code: string }
  | { kind: 'hr' };

/**
 * Only http:// and https:// URLs are permitted in Markdown links.
 * Rejects javascript:, data:, vbscript:, file:, relative paths, or control-char obfuscation.
 */
export function sanitizeMarkdownUrl(rawUrl: string): string | null {
  const cleaned = rawUrl.replace(/[\u0000-\u0020\u007f]+/g, '').trim();
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

const INLINE_TOKEN_RE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*/g;

/**
 * Parses inline markdown (inline code, links, bold, italic) into structured nodes.
 * Raw HTML is never interpreted; it remains literal text for safe React rendering.
 */
export function parseMarkdownInlines(text: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let lastIndex = 0;

  INLINE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }

    if (match[1] !== undefined) {
      nodes.push({ kind: 'code', text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const safeHref = sanitizeMarkdownUrl(match[3]);
      if (safeHref) {
        nodes.push({ kind: 'link', label: match[2], href: safeHref });
      } else {
        nodes.push({ kind: 'text', text: match[2] });
      }
    } else if (match[4] !== undefined) {
      nodes.push({ kind: 'strong', text: match[4] });
    } else if (match[5] !== undefined) {
      nodes.push({ kind: 'strong', text: match[5] });
    } else if (match[6] !== undefined) {
      nodes.push({ kind: 'em', text: match[6] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push({ kind: 'text', text: text.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ kind: 'text', text: '' }];
}

/**
 * Safe block-level Markdown parser for file preview.
 * Never emits HTML strings or uses dangerouslySetInnerHTML; all text nodes are
 * rendered as React text children so stored XSS payloads are neutralized.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const blocks: MarkdownBlock[] = [];

  let paragraphLines: string[] = [];
  let quoteLines: string[] = [];
  let listState: { ordered: boolean; items: MarkdownInline[][] } | null = null;
  let codeFence: { language: string | null; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push({
      kind: 'paragraph',
      inlines: parseMarkdownInlines(paragraphLines.join('\n')),
    });
    paragraphLines = [];
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    blocks.push({
      kind: 'blockquote',
      inlines: parseMarkdownInlines(quoteLines.join('\n')),
    });
    quoteLines = [];
  };

  const flushList = () => {
    if (!listState) return;
    blocks.push({
      kind: 'list',
      ordered: listState.ordered,
      items: listState.items,
    });
    listState = null;
  };

  const flushAllText = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (const rawLine of normalized.split('\n')) {
    const trimmedEnd = rawLine.trimEnd();
    const trimmed = trimmedEnd.trim();

    if (codeFence) {
      if (/^```/.test(trimmed)) {
        blocks.push({
          kind: 'code',
          language: codeFence.language,
          code: codeFence.lines.join('\n'),
        });
        codeFence = null;
      } else {
        codeFence.lines.push(trimmedEnd);
      }
      continue;
    }

    const fenceOpen = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(trimmed);
    if (fenceOpen) {
      flushAllText();
      codeFence = {
        language: fenceOpen[1] || null,
        lines: [],
      };
      continue;
    }

    if (!trimmed) {
      flushAllText();
      continue;
    }

    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
      flushAllText();
      blocks.push({ kind: 'hr' });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAllText();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        inlines: parseMarkdownInlines(heading[2].trim()),
      });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmedEnd.trimStart());
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (!listState || listState.ordered) {
        flushList();
        listState = { ordered: false, items: [] };
      }
      listState.items.push(parseMarkdownInlines(unordered[1].trim()));
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (!listState || !listState.ordered) {
        flushList();
        listState = { ordered: true, items: [] };
      }
      listState.items.push(parseMarkdownInlines(ordered[1].trim()));
      continue;
    }

    flushQuote();
    flushList();
    paragraphLines.push(trimmedEnd);
  }

  if (codeFence) {
    blocks.push({
      kind: 'code',
      language: codeFence.language,
      code: codeFence.lines.join('\n'),
    });
  }
  flushAllText();

  return blocks;
}
