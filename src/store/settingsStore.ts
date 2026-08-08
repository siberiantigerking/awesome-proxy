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

const defaultSettings: AppSettings = {
  socksPort: 1080,
  httpPort: 8080,
  mixedPort: 7890,
  proxyMode: 'system',
  allowLan: false,
  ipv6Strategy: 'block',
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
        set({ settings: { ...defaultSettings, ...settings } });
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