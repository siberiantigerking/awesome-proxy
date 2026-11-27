import { create } from 'zustand';
import type { AppSettings, TrafficStats, SplitRule } from '../types';
import { DEFAULT_DIRECT_DNS, DEFAULT_REMOTE_DNS } from '../services/dns-servers';

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
 *
 * 3 — `ipv6Strategy` default moved again, from 'prefer-ipv4' to 'ipv4-only'.
 *     Both dual-stack options assume we control DNS and can keep clients on
 *     IPv4 by withholding AAAA. Browsers with built-in DoH ignore our DNS, see
 *     a dual-stack TUN, and prefer IPv6 anyway — which breaks every connection
 *     when the node is IPv4-only. An IPv4-only TUN gives the OS no IPv6 route
 *     to prefer. 'block' is deliberately NOT migrated: it is an explicit
 *     privacy choice, and silently widening someone's exposure is worse than
 *     leaving them on a setting we now warn about in the UI.
 *
 * 4 — `ipv6Strategy` default moved back from 'ipv4-only' to 'block', now that
 *     'block' downgrades IPv6 to IPv4 at routing time instead of rejecting it.
 *     An IPv4-only TUN never captures IPv6, so on a network with real IPv6 the
 *     traffic leaves via the physical interface and the real address is visible
 *     to any site that tests it — reported from ip.sb in TUN mode. That is a
 *     leak, so it cannot stay the default. The reason 'block' was abandoned in
 *     v3 (DoH browsers reach for IPv6 and got a silent reset) is fixed by the
 *     downgrade, so the compatibility cost is gone. Only 'ipv4-only' is
 *     migrated, since that is the value the v3 default handed out.
 *
 * 5 — `tunStrictRoute` retired in favour of `tunBypassLocalNetworks`. TUN
 *     `strict_route` is now always on, because on Windows it is what installs
 *     the WFP port-53 filter that `dns_mode: hijack` relies on; without it
 *     Smart Multi-Homed Name Resolution lets the local network win the DNS race
 *     and nothing resolves correctly. Anyone carrying `tunStrictRoute: false`
 *     had a real problem to solve — WSL2 mirrored mode, Docker or Hyper-V losing
 *     connectivity — so their intent is carried over as
 *     `tunBypassLocalNetworks: true`, which keeps those subnets off the tunnel
 *     without disarming DNS protection. Anyone who left it at the default gets
 *     the new default (off) and an unchanged config.
 *
 * 6 — `remoteDns` and `directDns` take effect. The generator used to ignore
 *     both and always emit Cloudflare DoH 1.1.1.1 and AliDNS DoH 223.5.5.5 by
 *     IP literal, while the fields showed dns.google and dns.alidns.com
 *     (audit P0-8). A field still holding exactly its old default was never
 *     edited, so it moves to the literal the generator actually used, which is
 *     also the new default: nothing changes for anyone who never touched DNS,
 *     and the hostname defaults don't suddenly start needing a bootstrap
 *     lookup through the local resolver. Edited values are kept and now take
 *     effect.
 */
const SETTINGS_VERSION = 6;

/** The DNS defaults before v6, which the generator never used (see SETTINGS_VERSION 6). */
const LEGACY_DEFAULT_REMOTE_DNS = 'https://dns.google/dns-query';
const LEGACY_DEFAULT_DIRECT_DNS = 'https://dns.alidns.com/dns-query';

/** Retired keys, stripped on load so they stop travelling with saved settings. */
type RetiredSettings = { tunStrictRoute?: boolean };

const defaultSettings: AppSettings = {
  settingsVersion: SETTINGS_VERSION,
  socksPort: 1080,
  httpPort: 8080,
  separatePorts: false,
  mixedPort: 7890,
  proxyMode: 'system',
  allowLan: false,
  ipv6Strategy: 'block',
  tunBypassLocalNetworks: false,
  tunStack: 'mixed',
  remoteDns: DEFAULT_REMOTE_DNS,
  directDns: DEFAULT_DIRECT_DNS,
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  // A new key with a default needs no SETTINGS_VERSION bump: loadFromStore
  // merges stored settings over these defaults, so older files just pick it up.
  checkUpdatesOnStartup: true,
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
        const retired = settings as RetiredSettings;
        // Strip retired keys regardless of version, so a settings file that is
        // already current does not keep carrying them.
        delete (merged as AppSettings & RetiredSettings).tunStrictRoute;
        const storedVersion = (settings as AppSettings).settingsVersion || 1;
        if (storedVersion < SETTINGS_VERSION) {
          if (storedVersion < 2 && merged.ipv6Strategy === 'block') {
            merged.ipv6Strategy = 'prefer-ipv4';
          }
          // v3: move off the dual-stack default. Only 'prefer-ipv4' is touched,
          // since that is the value the old default handed out; 'block' is an
          // explicit choice and stays.
          if (storedVersion < 3 && merged.ipv6Strategy === 'prefer-ipv4') {
            merged.ipv6Strategy = 'ipv4-only';
          }
          // v4: 'ipv4-only' does not capture IPv6, so it leaks the real address
          // on IPv6-capable networks. Move to 'block', which now downgrades
          // IPv6 to IPv4 rather than rejecting it. 'prefer-ipv4' is left alone:
          // it is dual-stack, so it does not leak, and carrying IPv6 to the node
          // is an explicit choice.
          if (storedVersion < 4 && merged.ipv6Strategy === 'ipv4-only') {
            merged.ipv6Strategy = 'block';
          }
          // v5: strict_route is no longer optional. Someone who had switched it
          // off was working around a virtual network stack losing connectivity,
          // so carry that intent to the option that now handles it. Left at the
          // default (true/undefined) means nothing to carry.
          if (storedVersion < 5 && retired.tunStrictRoute === false) {
            merged.tunBypassLocalNetworks = true;
          }
          // v6: the DNS fields start to matter. Only the exact old default
          // counts as untouched; it moves to the server the generator has been
          // using all along, so the generated DNS stays what it was. Anything
          // else was typed by the user and is kept.
          if (storedVersion < 6) {
            if (merged.remoteDns === LEGACY_DEFAULT_REMOTE_DNS) merged.remoteDns = DEFAULT_REMOTE_DNS;
            if (merged.directDns === LEGACY_DEFAULT_DIRECT_DNS) merged.directDns = DEFAULT_DIRECT_DNS;
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