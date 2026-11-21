export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export type TurnstileStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'verified'
  | 'expired'
  | 'error';

export interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: (errorCode?: string) => void;
  theme?: 'light' | 'dark' | 'auto';
}

export interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export interface TurnstileScriptElement {
  src: string;
  async: boolean;
  defer: boolean;
  addEventListener: (type: 'load' | 'error', listener: () => void, options?: { once?: boolean }) => void;
}

export interface TurnstileDomEnv {
  win: { turnstile?: TurnstileApi };
  doc: {
    head: { appendChild: (node: TurnstileScriptElement) => void } | null;
    querySelector: (selector: string) => TurnstileScriptElement | null;
    createElement: (tag: 'script') => TurnstileScriptElement;
  };
}

function getDefaultDomEnv(): TurnstileDomEnv {
  return {
    win: window,
    doc: document as unknown as TurnstileDomEnv['doc'],
  };
}

/**
 * Creates a deduplicated loader for the Cloudflare Turnstile explicit-render script.
 * Failed loads clear the cached promise so a subsequent retry can re-attempt loading.
 */
export function createTurnstileScriptLoader(
  getEnv: () => TurnstileDomEnv = getDefaultDomEnv
): () => Promise<TurnstileApi> {
  let inflight: Promise<TurnstileApi> | null = null;

  return () => {
    const { win, doc } = getEnv();
    if (win.turnstile) {
      return Promise.resolve(win.turnstile);
    }
    if (inflight) {
      return inflight;
    }

    inflight = new Promise<TurnstileApi>((resolve, reject) => {
      const handleLoad = () => {
        if (win.turnstile) {
          resolve(win.turnstile);
        } else {
          inflight = null;
          reject(new Error('Turnstile script loaded without window.turnstile'));
        }
      };

      const handleError = () => {
        inflight = null;
        reject(new Error('Failed to load Cloudflare Turnstile script'));
      };

      const existing = doc.querySelector(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
      if (existing) {
        existing.addEventListener('load', handleLoad, { once: true });
        existing.addEventListener('error', handleError, { once: true });
        return;
      }

      if (!doc.head) {
        inflight = null;
        reject(new Error('Document head is unavailable for Turnstile script'));
        return;
      }

      const script = doc.createElement('script');
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', handleLoad, { once: true });
      script.addEventListener('error', handleError, { once: true });
      doc.head.appendChild(script);
    });

    return inflight;
  };
}

export const loadTurnstileScript = createTurnstileScriptLoader();

export interface TurnstileWidgetController {
  reset: () => void;
  remove: () => void;
  getWidgetId: () => string | null;
}

export interface MountTurnstileWidgetOptions {
  container: HTMLElement;
  siteKey: string;
  loadScript?: () => Promise<TurnstileApi>;
  onTokenChange: (token: string) => void;
  onStatusChange: (status: TurnstileStatus) => void;
  onErrorChange: (message: string | null) => void;
}

/**
 * Mounts an explicit Cloudflare Turnstile widget into `container` and manages
 * token/status callbacks, reset after submission, and `turnstile.remove` on unmount.
 */
export function mountTurnstileWidget(
  options: MountTurnstileWidgetOptions
): TurnstileWidgetController {
  const {
    container,
    siteKey,
    loadScript = loadTurnstileScript,
    onTokenChange,
    onStatusChange,
    onErrorChange,
  } = options;

  let disposed = false;
  let apiRef: TurnstileApi | null = null;
  let widgetId: string | null = null;

  onStatusChange('loading');
  onErrorChange(null);

  loadScript()
    .then((api) => {
      if (disposed) return;
      apiRef = api;
      widgetId = api.render(container, {
        sitekey: siteKey,
        theme: 'light',
        callback: (token: string) => {
          if (disposed) return;
          onTokenChange(token);
          onErrorChange(null);
          onStatusChange('verified');
        },
        'expired-callback': () => {
          if (disposed) return;
          onTokenChange('');
          onStatusChange('expired');
          onErrorChange('認証の有効期限が切れました。もう一度認証してください。');
        },
        'error-callback': () => {
          if (disposed) return;
          onTokenChange('');
          onStatusChange('error');
          onErrorChange('Turnstile 認証でエラーが発生しました。再試行してください。');
        },
      });
      onStatusChange('ready');
    })
    .catch(() => {
      if (disposed) return;
      onTokenChange('');
      onStatusChange('error');
      onErrorChange(
        'Turnstile ウィジェットの読み込みに失敗しました。通信状況を確認して再試行してください。'
      );
    });

  return {
    reset: () => {
      if (disposed) return;
      onTokenChange('');
      onErrorChange(null);
      if (apiRef && widgetId !== null) {
        apiRef.reset(widgetId);
        onStatusChange('ready');
      }
    },
    remove: () => {
      if (disposed) return;
      disposed = true;
      if (apiRef && widgetId !== null) {
        apiRef.remove(widgetId);
      }
      widgetId = null;
      apiRef = null;
    },
    getWidgetId: () => widgetId,
  };
}
