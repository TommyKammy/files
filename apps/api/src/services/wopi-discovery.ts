import type { OidcEnv } from '../types/oidc';

const DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000;

export interface WopiDiscoveryAction {
  appName: string;
  name: string;
  extension: string;
  urlsrc: string;
}

interface CacheEntry {
  actions: WopiDiscoveryAction[];
  expiresAt: number;
}

const discoveryCache = new Map<string, CacheEntry>();

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 16))
    );
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9:_-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

/**
 * Parse the small subset of WOPI discovery XML that Collabora emits.
 * Avoids a DOMParser dependency in Workers.
 */
export function parseWopiDiscoveryXml(xml: string): WopiDiscoveryAction[] {
  const actions: WopiDiscoveryAction[] = [];
  const appRegex = /<app\b([^>]*)>([\s\S]*?)<\/app>/gi;
  let appMatch: RegExpExecArray | null;
  while ((appMatch = appRegex.exec(xml)) !== null) {
    const appAttrs = parseAttributes(appMatch[1]);
    const appName = appAttrs.name ?? '';
    const actionRegex = /<action\b([^>]*)\/?>/gi;
    let actionMatch: RegExpExecArray | null;
    while ((actionMatch = actionRegex.exec(appMatch[2])) !== null) {
      const attrs = parseAttributes(actionMatch[1]);
      if (!attrs.name || !attrs.ext || !attrs.urlsrc) continue;
      actions.push({
        appName,
        name: attrs.name.toLowerCase(),
        extension: attrs.ext.toLowerCase().replace(/^\./, ''),
        urlsrc: attrs.urlsrc,
      });
    }
  }
  return actions;
}

export function getWopiDiscoveryEndpoint(
  env: Pick<OidcEnv, 'WOPI_DISCOVERY_URL' | 'COLLABORA_URL'>
): string | null {
  const explicit = env.WOPI_DISCOVERY_URL?.trim();
  if (explicit) return explicit;
  const collabora = env.COLLABORA_URL?.trim();
  if (!collabora) return null;
  return `${collabora.replace(/\/+$/, '')}/hosting/discovery`;
}

export async function getWopiDiscovery(
  env: Pick<OidcEnv, 'WOPI_DISCOVERY_URL' | 'COLLABORA_URL'>,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {}
): Promise<WopiDiscoveryAction[] | null> {
  const endpoint = getWopiDiscoveryEndpoint(env);
  if (!endpoint) return null;

  const now = options.now?.() ?? Date.now();
  const cached = discoveryCache.get(endpoint);
  if (cached && cached.expiresAt > now) {
    return cached.actions;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(endpoint, {
    headers: { Accept: 'text/xml, application/xml' },
  });
  if (!res.ok) {
    throw new Error(`WOPI discovery failed: ${res.status}`);
  }
  const actions = parseWopiDiscoveryXml(await res.text());
  discoveryCache.set(endpoint, {
    actions,
    expiresAt: now + DISCOVERY_CACHE_TTL_MS,
  });
  return actions;
}

export function clearWopiDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}

export function resolveWopiActionUrl(
  actions: ReadonlyArray<WopiDiscoveryAction>,
  input: {
    extension: string | null | undefined;
    canWrite: boolean;
    wopiSrc: string;
  }
): string | null {
  const extension = input.extension?.toLowerCase().replace(/^\./, '') ?? '';
  if (!extension) return null;

  const candidates = actions.filter(
    (action) => action.extension === extension
  );
  if (candidates.length === 0) return null;

  const preferredNames = input.canWrite ? ['edit', 'view'] : ['view', 'edit'];
  let selected: WopiDiscoveryAction | undefined;
  for (const name of preferredNames) {
    selected = candidates.find((action) => action.name === name);
    if (selected) break;
  }
  selected ??= candidates[0];
  if (!selected) return null;

  if (selected.urlsrc.includes('<WOPISrc>')) {
    return selected.urlsrc.replace(
      '<WOPISrc>',
      encodeURIComponent(input.wopiSrc)
    );
  }
  const url = new URL(selected.urlsrc);
  url.searchParams.set('WOPISrc', input.wopiSrc);
  return url.toString();
}

export function buildWopiSrc(
  env: Pick<OidcEnv, 'WOPI_HOST_ORIGIN' | 'APP_ORIGIN'>,
  fileId: string
): string {
  const origin =
    env.WOPI_HOST_ORIGIN?.trim() ||
    env.APP_ORIGIN?.trim() ||
    'http://127.0.0.1:8787';
  return new URL(`/wopi/files/${encodeURIComponent(fileId)}`, origin).toString();
}
