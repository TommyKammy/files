export const SINGLE_USE_PREVIEW_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  promise: Promise<ArrayBuffer>;
  expiresAt: number;
}

const bufferCache = new Map<string, CacheEntry>();

function prune(now: number): void {
  for (const [key, entry] of bufferCache) {
    if (entry.expiresAt <= now) bufferCache.delete(key);
  }
}

/**
 * Fetch a (single-use) preview URL exactly once per URL and reuse the bytes for
 * the lifetime of the short-lived token.
 *
 * React StrictMode intentionally double-invokes effects in development. Without
 * this cache the second effect would replay the URL after the first request
 * consumed the D1 nonce and receive HTTP 410. Keeping the promise module-level
 * also dedupes concurrent consumers (image + text renderers) without exposing a
 * reusable URL to the network layer: a second external `curl` still gets 410.
 */
export function fetchSingleUsePreviewBuffer(
  url: string,
  credentials: RequestCredentials = 'include',
  now: number = Date.now()
): Promise<ArrayBuffer> {
  prune(now);
  const cached = bufferCache.get(url);
  if (cached) return cached.promise;

  const promise = fetch(url, { credentials })
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`プレビューデータの取得に失敗しました (HTTP ${res.status})`);
      }
      return res.arrayBuffer();
    })
    .catch((err) => {
      // A failed fetch must not permanently poison the cache key.
      bufferCache.delete(url);
      throw err;
    });

  bufferCache.set(url, {
    promise,
    expiresAt: now + SINGLE_USE_PREVIEW_CACHE_TTL_MS,
  });
  return promise;
}

export function clearSingleUsePreviewBufferCache(): void {
  bufferCache.clear();
}

export function singleUsePreviewBufferCacheSize(): number {
  return bufferCache.size;
}
