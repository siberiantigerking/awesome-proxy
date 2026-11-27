import { contextBridge, ipcRenderer } from 'electron';
// Type-only, so it is erased from preload.js: the sandboxed preload can only
// require 'electron', and a runtime require would take the whole bridge down.
import type { AppUpdateStatus } from './app-updater';

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
    getSelection: (selector: string) => ipcRenderer.invoke('singbox:selection', selector),
    checkUpdate: () => ipcRenderer.invoke('singbox:check-update'),
    // Only the user's "install anyway" answer crosses over; main decides what
    // to download and checks it against GitHub's digest.
    upgrade: (options?: { allowUnvalidated?: boolean }) =>
      ipcRenderer.invoke('singbox:upgrade', { allowUnvalidated: options?.allowUnvalidated === true }),
    getCoreBackup: () => ipcRenderer.invoke('singbox:core-backup'),
    restorePreviousCore: () => ipcRenderer.invoke('singbox:restore-core'),
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
    // The core watchdog gave up (main.ts giveUpOnCore). The type is spelled out
    // here rather than imported, so nothing but 'electron' is required at runtime.
    onCrashed: (callback: (info: { message: string; lines: string[]; at: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, info: { message: string; lines: string[]; at: number }) =>
        callback(info);
      ipcRenderer.on('singbox:crashed', listener);
      return () => {
        ipcRenderer.removeListener('singbox:crashed', listener);
      };
    },
  },

  // Configuration management
  config: {
    generate: (nodes: any[], selectedIndex: number, settings: any) =>
      ipcRenderer.invoke('config:generate', nodes, selectedIndex, settings),
    write: (config: object) => ipcRenderer.invoke('config:write', config),
  },

  // System proxy
  systemProxy: {
    enable: (host: string, port: number) =>
      ipcRenderer.invoke('system-proxy:enable', host, port),
    disable: () => ipcRenderer.invoke('system-proxy:disable'),
    getStatus: () => ipcRenderer.invoke('system-proxy:status'),
  },

  // File pickers only: they return the path the user chose. Nothing here reads
  // or writes a file by path (audit P0-5).
  file: {
    selectFile: (filters?: { name: string; extensions: string[] }[]) =>
      ipcRenderer.invoke('file:select', filters),
    selectDirectory: () => ipcRenderer.invoke('file:select-directory'),
  },

  // Store (persistent data)
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key),
  },

  // Tray (its Disconnect runs in main, so only Connect reaches the renderer)
  tray: {
    setMode: (mode: string) => ipcRenderer.invoke('tray:set-mode', mode),
    onConnect: (callback: () => void) => {
      ipcRenderer.on('tray:connect', () => callback());
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
    testDelay: (tag: string, url?: string, timeout?: number) =>
      ipcRenderer.invoke('network:test-delay', tag, url, timeout),
    testUdp: (proxyPort: number) => ipcRenderer.invoke('network:test-udp', proxyPort),
    testSpeed: (proxyPort: number, options?: { url?: string; durationMs?: number }) =>
      ipcRenderer.invoke('network:test-speed', proxyPort, options),
    getLanAddresses: () => ipcRenderer.invoke('network:get-lan-addresses'),
  },

  // In-app updates of Awesome Proxy itself (electron-updater, GitHub Releases).
  // Not the sing-box core upgrade under `singbox`, not the subscription
  // scheduler. Takes no URLs or paths: main decides where updates come from.
  updater: {
    check: (options?: { background?: boolean }) =>
      ipcRenderer.invoke('app-updater:check', { background: options?.background === true }),
    download: () => ipcRenderer.invoke('app-updater:download'),
    install: () => ipcRenderer.invoke('app-updater:install'),
    openReleasesPage: () => ipcRenderer.invoke('app-updater:open-releases'),
    onStatus: (callback: (status: AppUpdateStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => callback(status);
      ipcRenderer.on('app-updater:status', listener);
      return () => {
        ipcRenderer.removeListener('app-updater:status', listener);
      };
    },
  },
});