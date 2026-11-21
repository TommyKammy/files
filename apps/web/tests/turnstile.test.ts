import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTurnstileScriptLoader,
  mountTurnstileWidget,
  TURNSTILE_SCRIPT_URL,
  type TurnstileApi,
  type TurnstileDomEnv,
  type TurnstileRenderOptions,
  type TurnstileScriptElement,
  type TurnstileStatus,
} from '@/lib/turnstile';

function createMockDomEnv() {
  const appendedScripts: Array<
    TurnstileScriptElement & { emit: (type: 'load' | 'error') => void }
  > = [];
  const win: { turnstile?: TurnstileApi } = {};

  const doc: TurnstileDomEnv['doc'] = {
    head: {
      appendChild(node) {
        appendedScripts.push(
          node as TurnstileScriptElement & { emit: (type: 'load' | 'error') => void }
        );
      },
    },
    querySelector(selector) {
      if (selector === `script[src="${TURNSTILE_SCRIPT_URL}"]`) {
        return appendedScripts.find((s) => s.src === TURNSTILE_SCRIPT_URL) ?? null;
      }
      return null;
    },
    createElement() {
      const listeners: Record<'load' | 'error', Array<() => void>> = {
        load: [],
        error: [],
      };
      return {
        src: '',
        async: false,
        defer: false,
        addEventListener(type: 'load' | 'error', listener: () => void) {
          listeners[type].push(listener);
        },
        emit(type: 'load' | 'error') {
          for (const fn of listeners[type]) fn();
        },
      } as TurnstileScriptElement & { emit: (type: 'load' | 'error') => void };
    },
  };

  return { win, doc, appendedScripts };
}

test('createTurnstileScriptLoader deduplicates concurrent loads and recovers after error', async () => {
  const { win, doc, appendedScripts } = createMockDomEnv();
  const load = createTurnstileScriptLoader(() => ({ win, doc }));

  const firstAttempt = load();
  const secondAttempt = load();
  assert.equal(appendedScripts.length, 1);
  assert.equal(appendedScripts[0]?.src, TURNSTILE_SCRIPT_URL);
  assert.equal(appendedScripts[0]?.async, true);
  assert.equal(appendedScripts[0]?.defer, true);

  // Simulate load failure; inflight promise should clear so retry works.
  appendedScripts[0]?.emit('error');
  await assert.rejects(firstAttempt, /Failed to load Cloudflare Turnstile script/);
  await assert.rejects(secondAttempt, /Failed to load Cloudflare Turnstile script/);

  // Remove failed script from mock list to simulate fresh retry
  appendedScripts.length = 0;

  const mockApi: TurnstileApi = {
    render: () => 'w-1',
    reset: () => {},
    remove: () => {},
  };
  const retryAttempt = load();
  assert.equal(appendedScripts.length, 1);
  win.turnstile = mockApi;
  appendedScripts[0]?.emit('load');

  const resolved = await retryAttempt;
  assert.equal(resolved, mockApi);

  // Subsequent calls resolve immediately without creating another script tag.
  const immediate = await load();
  assert.equal(immediate, mockApi);
  assert.equal(appendedScripts.length, 1);
});

test('mountTurnstileWidget wires callbacks, reset, and unmount removal', async () => {
  let capturedOptions: TurnstileRenderOptions | null = null;
  const resetCalls: Array<string | undefined> = [];
  const removeCalls: Array<string | undefined> = [];

  const mockApi: TurnstileApi = {
    render(_container, options) {
      capturedOptions = options;
      return 'widget-123';
    },
    reset(widgetId) {
      resetCalls.push(widgetId);
    },
    remove(widgetId) {
      removeCalls.push(widgetId);
    },
  };

  let token = '';
  let status: TurnstileStatus = 'idle';
  let errorMessage: string | null = null;

  const controller = mountTurnstileWidget({
    container: {} as HTMLElement,
    siteKey: '0x4AAAAAAATestSiteKey',
    loadScript: async () => mockApi,
    onTokenChange: (t) => {
      token = t;
    },
    onStatusChange: (s) => {
      status = s;
    },
    onErrorChange: (m) => {
      errorMessage = m;
    },
  });

  // Flush microtask for async loadScript
  await Promise.resolve();

  assert.equal(controller.getWidgetId(), 'widget-123');
  assert.equal(status, 'ready');
  assert.ok(capturedOptions);
  const opts = capturedOptions as TurnstileRenderOptions;
  assert.equal(opts.sitekey, '0x4AAAAAAATestSiteKey');

  // Verify callback stores token
  opts.callback?.('ts-token-abc');
  assert.equal(token, 'ts-token-abc');
  assert.equal(status, 'verified');
  assert.equal(errorMessage, null);

  // Verify expired-callback clears token and surfaces message
  opts['expired-callback']?.();
  assert.equal(token, '');
  assert.equal(status, 'expired');
  assert.equal(typeof errorMessage, 'string');
  assert.ok((errorMessage as string | null)?.length);

  // Verify error-callback clears token and surfaces retryable error
  opts.callback?.('ts-token-def');
  opts['error-callback']?.('110200');
  assert.equal(token, '');
  assert.equal(status, 'error');
  assert.equal(typeof errorMessage, 'string');
  assert.ok((errorMessage as string | null)?.length);

  // Verify reset clears token/error and calls turnstile.reset(widgetId)
  opts.callback?.('ts-token-ghi');
  controller.reset();
  assert.equal(token, '');
  assert.equal(errorMessage, null);
  assert.equal(status, 'ready');
  assert.deepEqual(resetCalls, ['widget-123']);

  // Verify remove calls turnstile.remove(widgetId) once and ignores late callbacks
  controller.remove();
  controller.remove();
  assert.deepEqual(removeCalls, ['widget-123']);
  assert.equal(controller.getWidgetId(), null);

  opts.callback?.('late-token');
  assert.equal(token, '');
});

test('mountTurnstileWidget skips render if unmounted before script finishes loading', async () => {
  let renderCount = 0;
  let resolveLoad!: (api: TurnstileApi) => void;
  const loadPromise = new Promise<TurnstileApi>((resolve) => {
    resolveLoad = resolve;
  });

  const controller = mountTurnstileWidget({
    container: {} as HTMLElement,
    siteKey: '0x4AAAAAAATestSiteKey',
    loadScript: () => loadPromise,
    onTokenChange: () => {},
    onStatusChange: () => {},
    onErrorChange: () => {},
  });

  controller.remove();
  resolveLoad({
    render: () => {
      renderCount += 1;
      return 'widget-late';
    },
    reset: () => {},
    remove: () => {},
  });

  await Promise.resolve();
  assert.equal(renderCount, 0);
  assert.equal(controller.getWidgetId(), null);
});
