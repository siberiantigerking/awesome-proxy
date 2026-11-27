import { vi } from 'vitest';

/**
 * In-memory stand-in for the preload bridge (`window.api`), for renderer
 * modules that persist through `window.api.store` or call the backend.
 *
 * The store behaves like the real path through IPC and electron-store:
 *   - `get` hands back a structured clone, as IPC does, so a caller mutating
 *     what it loaded can never reach the stored value;
 *   - `set(key, undefined)` throws, as electron-store does
 *     ("Use `delete()` to clear values"), so code that writes an undefined
 *     key fails here just as it would in the app.
 *
 * Every `set` is also recorded in `sets`, in order, so a test can tell
 * "saved once" from "not saved".
 *
 * Call `vi.unstubAllGlobals()` in afterEach to remove the global again.
 */
export interface MockApi {
  api: any;
  store: Map<string, unknown>;
  sets: [string, unknown][];
}

type Overrides = Record<string, Record<string, unknown>>;

export function installMockApi(initialStore: Record<string, unknown> = {}, overrides: Overrides = {}): MockApi {
  const store = new Map<string, unknown>(
    Object.entries(initialStore).map(([key, value]) => [key, structuredClone(value)])
  );
  const sets: [string, unknown][] = [];

  const api: any = {
    store: {
      get: vi.fn(async (key: string) => (store.has(key) ? structuredClone(store.get(key)) : undefined)),
      set: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) throw new TypeError('Use `delete()` to clear values');
        // structuredClone also rejects what IPC cannot carry (functions, ...).
        store.set(key, structuredClone(value));
        sets.push([key, structuredClone(value)]);
        return true;
      }),
      delete: vi.fn(async (key: string) => store.delete(key)),
    },
    network: {
      fetchUrl: vi.fn(async () => ''),
      testLatency: vi.fn(async () => -1),
      testDelay: vi.fn(async () => -1),
      testUdp: vi.fn(async () => ({ ok: false, ms: 0, error: 'mock' })),
      testSpeed: vi.fn(async () => ({ mbps: 0, bytes: 0, ms: 0, error: 'mock' })),
      getLanAddresses: vi.fn(async () => []),
    },
    singbox: {
      start: vi.fn(async () => ({ success: true })),
      stop: vi.fn(async () => ({ success: true })),
      restart: vi.fn(async () => ({ success: true })),
      getStatus: vi.fn(async () => 'disconnected'),
      getVersion: vi.fn(async () => '1.14.4'),
      getLogs: vi.fn(async () => []),
      clearLogs: vi.fn(async () => true),
      select: vi.fn(async () => ({ success: true })),
      getSelection: vi.fn(async () => ({ success: true, now: undefined })),
      checkUpdate: vi.fn(async () => ({ success: false, error: 'mock' })),
      upgrade: vi.fn(async () => ({ success: false, error: 'mock' })),
      onUpgradeProgress: vi.fn(),
      onLog: vi.fn(),
      onStatusChange: vi.fn(),
      onTrafficUpdate: vi.fn(),
      onCrashed: vi.fn(() => () => {}),
    },
    config: {
      generate: vi.fn(async () => ({})),
      write: vi.fn(async () => 'C:\\awesome-proxy-test\\config.json'),
    },
    systemProxy: {
      enable: vi.fn(async () => true),
      disable: vi.fn(async () => true),
      getStatus: vi.fn(async () => ({ enabled: false, server: '' })),
    },
    app: {
      isAdmin: vi.fn(async () => false),
    },
  };

  for (const [namespace, fns] of Object.entries(overrides)) {
    api[namespace] = { ...(api[namespace] || {}), ...fns };
  }

  vi.stubGlobal('window', { api });
  return { api, store, sets };
}
