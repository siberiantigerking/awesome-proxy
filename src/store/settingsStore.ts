import { create } from 'zustand';
import type { AppSettings, TrafficStats, SplitRule } from '../types';

interface SettingsStore {
  settings: AppSettings;
  singboxVersion: string;
  appVersion: string;

  // Traffic
  traffic: TrafficStats;

  // Actions
  updateSettings: (updates: Partial<AppSettings>) => void;
  setSingboxVersion: (version: string) => void;
  setAppVersion: (version: string) => void;
  updateTraffic: (up: number, down: number) => void;
  resetTraffic: () => void;

  // Persistence
  loadFromStore: () => Promise<void>;
  saveToStore: () => Promise<void>;
}

/**
 * Current persisted-settings schema version.
 *
 * 2 — `ipv6Strategy` default moved from 'block' to 'prefer-ipv4'. Both are
 *     leak-safe, but 'block' leaves a black-holed IPv6 default route which
 *     degrades throughput/latency on IPv6-capable networks. Anyone still
 *     carrying the old default is migrated once; picking 'block' again after
 *     the migration sticks, because the version marker is already stamped.
 */
const SETTINGS_VERSION = 2;

const defaultSettings: AppSettings = {
  settingsVersion: SETTINGS_VERSION,
  socksPort: 1080,
  httpPort: 8080,
  separatePorts: false,
  mixedPort: 7890,
  proxyMode: 'system',
  allowLan: false,
  ipv6Strategy: 'prefer-ipv4',
  tunStrictRoute: true,
  remoteDns: 'https://dns.google/dns-query',
  directDns: 'https://dns.alidns.com/dns-query',
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  theme: 'dark',
  splitRules: [],
  splitApps: [],
  splitMode: 'proxy',
};

const defaultTraffic: TrafficStats = {
  uploadSpeed: 0,
  downloadSpeed: 0,
  totalUpload: 0,
  totalDownload: 0,
  history: [],
};

const MAX_HISTORY = 60; // 60 data points (1 per second = 1 minute of history)

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: { ...defaultSettings },
  singboxVersion: 'Unknown',
  appVersion: '1.0.0',
  traffic: { ...defaultTraffic },

  updateSettings: (updates) => {
    set((state) => ({
      settings: { ...state.settings, ...updates },
    }));
    get().saveToStore();
  },

  setSingboxVersion: (version) => set({ singboxVersion: version }),
  setAppVersion: (version) => set({ appVersion: version }),

  updateTraffic: (up, down) => {
    set((state) => {
      const history = [
        ...state.traffic.history,
        { up, down, timestamp: Date.now() },
      ].slice(-MAX_HISTORY);

      return {
        traffic: {
          uploadSpeed: up,
          downloadSpeed: down,
          totalUpload: state.traffic.totalUpload + up,
          totalDownload: state.traffic.totalDownload + down,
          history,
        },
      };
    });
  },

  resetTraffic: () => {
    set({ traffic: { ...defaultTraffic } });
  },

  loadFromStore: async () => {
    try {
      const settings = await window.api.store.get('settings');
      if (settings) {
        const merged: AppSettings = { ...defaultSettings, ...settings };
        const storedVersion = (settings as AppSettings).settingsVersion || 1;
        if (storedVersion < SETTINGS_VERSION) {
          if (storedVersion < 2 && merged.ipv6Strategy === 'block') {
            merged.ipv6Strategy = 'prefer-ipv4';
          }
          merged.settingsVersion = SETTINGS_VERSION;
          set({ settings: merged });
          await get().saveToStore();
          return;
        }
        set({ settings: merged });
      }
    } catch (err) {
      console.error('Failed to load settings from store:', err);
    }
  },

  saveToStore: async () => {
    try {
      const { settings } = get();
      await window.api.store.set('settings', settings);
    } catch (err) {
      console.error('Failed to save settings to store:', err);
    }
  },
}));