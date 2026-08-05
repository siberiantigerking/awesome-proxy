import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // sing-box core management
  singbox: {
    start: (configPath: string) => ipcRenderer.invoke('singbox:start', configPath),
    stop: () => ipcRenderer.invoke('singbox:stop'),
    restart: (configPath: string) => ipcRenderer.invoke('singbox:restart', configPath),
    getStatus: () => ipcRenderer.invoke('singbox:status'),
    getVersion: () => ipcRenderer.invoke('singbox:version'),
    getLogs: () => ipcRenderer.invoke('singbox:logs'),
    clearLogs: () => ipcRenderer.invoke('singbox:clear-logs'),
    select: (selector: string, outbound: string) =>
      ipcRenderer.invoke('singbox:select', selector, outbound),
    checkUpdate: () => ipcRenderer.invoke('singbox:check-update'),
    upgrade: () => ipcRenderer.invoke('singbox:upgrade'),
    onUpgradeProgress: (callback: (data: { stage: string; percent?: number; message?: string }) => void) => {
      ipcRenderer.on('singbox:upgrade-progress', (_event, data) => callback(data));
    },
    onLog: (callback: (log: string) => void) => {
      ipcRenderer.on('singbox:log', (_event, log) => callback(log));
    },
    onStatusChange: (callback: (status: string) => void) => {
      ipcRenderer.on('singbox:status-change', (_event, status) => callback(status));
    },
    onTrafficUpdate: (callback: (data: { up: number; down: number }) => void) => {
      ipcRenderer.on('singbox:traffic', (_event, data) => callback(data));
    },
  },

  // Configuration management
  config: {
    generate: (nodes: any[], selectedIndex: number, settings: any) =>
      ipcRenderer.invoke('config:generate', nodes, selectedIndex, settings),
    write: (config: object) => ipcRenderer.invoke('config:write', config),
    read: () => ipcRenderer.invoke('config:read'),
  },

  // System proxy
  systemProxy: {
    enable: (host: string, port: number) =>
      ipcRenderer.invoke('system-proxy:enable', host, port),
    disable: () => ipcRenderer.invoke('system-proxy:disable'),
    getStatus: () => ipcRenderer.invoke('system-proxy:status'),
  },

  // File operations
  file: {
    selectFile: (filters?: { name: string; extensions: string[] }[]) =>
      ipcRenderer.invoke('file:select', filters),
    selectDirectory: () => ipcRenderer.invoke('file:select-directory'),
    readText: (filePath: string) => ipcRenderer.invoke('file:read-text', filePath),
    writeText: (filePath: string, content: string) =>
      ipcRenderer.invoke('file:write-text', filePath, content),
  },

  // Store (persistent data)
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key),
  },

  // Tray
  tray: {
    setMode: (mode: string) => ipcRenderer.invoke('tray:set-mode', mode),
    onConnect: (callback: () => void) => {
      ipcRenderer.on('tray:connect', () => callback());
    },
    onDisconnect: (callback: () => void) => {
      ipcRenderer.on('tray:disconnect', () => callback());
    },
  },

  // App info
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    getPlatform: () => ipcRenderer.invoke('app:platform'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    maximize: () => ipcRenderer.invoke('app:maximize'),
    close: () => ipcRenderer.invoke('app:close'),
    quit: () => ipcRenderer.invoke('app:quit'),
    setAutoStart: (enabled: boolean) => ipcRenderer.invoke('app:set-autostart', enabled),
    getAutoStart: () => ipcRenderer.invoke('app:get-autostart'),
    isAdmin: () => ipcRenderer.invoke('app:is-admin'),
    relaunchAsAdmin: () => ipcRenderer.invoke('app:relaunch-as-admin'),
    setStartMinimized: (enabled: boolean) =>
      ipcRenderer.invoke('app:set-start-minimized', enabled),
  },

  // Network
  network: {
    fetchUrl: (url: string, timeout?: number) =>
      ipcRenderer.invoke('network:fetch-url', url, timeout),
    testLatency: (host: string, port: number) =>
      ipcRenderer.invoke('network:test-latency', host, port),
    getLanAddresses: () => ipcRenderer.invoke('network:get-lan-addresses'),
  },
});