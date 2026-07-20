/**
 * Web-mode API that communicates with the local backend server (server/index.js)
 * Falls back to localStorage for persistence if backend is unavailable.
 */

const API_BASE = '/api';
const WS_URL = `ws://${window.location.hostname}:3456`;

const STORAGE_PREFIX = 'singbox_pm_';

function localStorageGet(key: string): any {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function localStorageSet(key: string, value: any): void {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
}

function localStorageDelete(key: string): void {
  localStorage.removeItem(STORAGE_PREFIX + key);
}

// Default settings
const defaultSettings = {
  socksPort: 1080,
  httpPort: 8080,
  mixedPort: 7890,
  proxyMode: 'system',
  remoteDns: 'https://dns.google/dns-query',
  directDns: 'https://dns.alidns.com/dns-query',
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  theme: 'dark',
};

// ==================== Backend communication ====================

async function apiFetch(path: string, options?: RequestInit): Promise<any> {
  try {
    const resp = await fetch(API_BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    return await resp.json();
  } catch (err: any) {
    console.warn('[Web API] Backend not available, falling back to local:', err.message);
    return null;
  }
}

async function apiPost(path: string, body?: any): Promise<any> {
  return apiFetch(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function apiGet(path: string): Promise<any> {
  return apiFetch(path, { method: 'GET' });
}

// ==================== WebSocket for real-time events ====================

let ws: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

const listeners: Record<string, Function[]> = {
  'singbox:status-change': [],
  'singbox:traffic': [],
  'singbox:log': [],
};

function connectWebSocket() {
  try {
    ws = new WebSocket(WS_URL);
    ws.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data);
        if (listeners[type]) {
          listeners[type].forEach((cb) => cb(data));
        }
      } catch {}
    };
    ws.onclose = () => {
      ws = null;
      wsReconnectTimer = setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = () => {
      // Silent - will reconnect via onclose
    };
  } catch {
    // Backend not running
  }
}

// Initialize WebSocket connection
connectWebSocket();

export const webApi = {
  singbox: {
    start: async (_configPath: string) => {
      const result = await apiPost('/singbox/start', { configPath: _configPath });
      return result || { success: false, error: 'Backend server not reachable. Please start it with: npm run server' };
    },
    stop: async () => {
      const result = await apiPost('/singbox/stop');
      return result || { success: true };
    },
    restart: async (_configPath: string) => {
      const result = await apiPost('/singbox/restart', { configPath: _configPath });
      return result || { success: false, error: 'Backend server not reachable' };
    },
    getStatus: async () => {
      const result = await apiGet('/singbox/status');
      return result?.status || 'disconnected';
    },
    getVersion: async () => {
      const result = await apiGet('/singbox/version');
      return result?.version || 'Backend not connected';
    },
    getLogs: async () => {
      const result = await apiGet('/singbox/logs');
      return result?.logs || [];
    },
    clearLogs: async () => {
      await apiPost('/singbox/clear-logs');
      return true;
    },
    select: async (selector: string, outbound: string) => {
      const result = await apiPost('/singbox/select', { selector, outbound });
      return result || { success: false, error: 'Backend not reachable' };
    },
    checkUpdate: async () => {
      const result = await apiGet('/singbox/check-update');
      return result || { success: false, error: 'Core upgrade is only available in the desktop app.' };
    },
    upgrade: async () => {
      const result = await apiPost('/singbox/upgrade');
      return result || { success: false, error: 'Core upgrade is only available in the desktop app.' };
    },
    onUpgradeProgress: (_callback: (data: { stage: string; percent?: number; message?: string }) => void) => {
      // Web mode: upgrade progress events are not streamed.
    },
    onLog: (callback: (log: string) => void) => {
      listeners['singbox:log'].push(callback);
    },
    onStatusChange: (callback: (status: string) => void) => {
      listeners['singbox:status-change'].push(callback);
    },
    onTrafficUpdate: (callback: (data: { up: number; down: number }) => void) => {
      listeners['singbox:traffic'].push(callback);
    },
  },

  // Tray is desktop-only; no-op in web mode.
  tray: {
    setMode: async (_mode: string) => {},
    onConnect: (_callback: () => void) => {},
    onDisconnect: (_callback: () => void) => {},
  },

  config: {
    generate: async (nodes: any[], selectedIndex: number, settings: any) => {
      const result = await apiPost('/config/generate', { nodes, selectedIndex, settings });
      return result?.config || {};
    },
    write: async (config: object) => {
      const result = await apiPost('/config/write', { config });
      return result?.path || 'config-saved';
    },
    read: async () => {
      const result = await apiGet('/config/read');
      return result?.config || null;
    },
  },

  systemProxy: {
    enable: async (host: string, port: number) => {
      const result = await apiPost('/system-proxy/enable', { host, port });
      return result?.success || false;
    },
    disable: async () => {
      const result = await apiPost('/system-proxy/disable');
      return result?.success || false;
    },
    getStatus: async () => {
      const result = await apiGet('/system-proxy/status');
      return result || { enabled: false, server: '' };
    },
  },

  file: {
    selectFile: async () => {
      return new Promise<string | null>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.json,.yaml,.yml';
        input.onchange = () => {
          const file = input.files?.[0];
          resolve(file ? file.name : null);
        };
        input.oncancel = () => resolve(null);
        input.click();
      });
    },
    selectDirectory: async () => null,
    readText: async (_filePath: string) => {
      return new Promise<string>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = () => {
          const file = input.files?.[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsText(file);
          } else {
            resolve('');
          }
        };
        input.click();
      });
    },
    writeText: async (_filePath: string, content: string) => {
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = _filePath.split(/[/\\]/).pop() || 'output.txt';
      a.click();
      URL.revokeObjectURL(url);
      return true;
    },
  },

  store: {
    get: async (key: string) => {
      const result = await apiGet('/store/' + encodeURIComponent(key));
      if (result && result.value !== undefined) {
        // Also cache locally
        localStorageSet(key, result.value);
        return result.value;
      }
      // Fallback to localStorage
      return localStorageGet(key);
    },
    set: async (key: string, value: any) => {
      await apiFetch('/store/' + encodeURIComponent(key), {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      localStorageSet(key, value);
      return true;
    },
    delete: async (key: string) => {
      await apiFetch('/store/' + encodeURIComponent(key), {
        method: 'DELETE',
      });
      localStorageDelete(key);
      return true;
    },
  },

  app: {
    getVersion: async () => {
      const result = await apiGet('/app/version');
      return result?.version || '1.0.0';
    },
    getPlatform: async () => {
      const result = await apiGet('/app/platform');
      return result?.platform || 'web';
    },
    minimize: async () => {},
    maximize: async () => {},
    close: async () => {},
    quit: async () => {},
    setAutoStart: async (_enabled: boolean) => {},
    getAutoStart: async () => false,
    isAdmin: async () => false,
    relaunchAsAdmin: async () => false,
    setStartMinimized: async (_enabled: boolean) => {},
  },

  network: {
    fetchUrl: async (url: string, timeout?: number) => {
      const result = await apiPost('/network/fetch-url', { url, timeout });
      if (result?.error) throw new Error(result.error);
      return result?.data || '';
    },
    testLatency: async (host: string, port: number) => {
      const result = await apiPost('/network/test-latency', { host, port });
      return result?.latency ?? -1;
    },
  },
};