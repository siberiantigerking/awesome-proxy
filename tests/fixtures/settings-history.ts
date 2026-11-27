/**
 * Settings exactly as each schema version left them in the store, for the
 * migration suite. Field sets follow the defaults each tagged release shipped
 * (git history of src/store/settingsStore.ts: v1.2.0 for V1, v1.3.3 for V2,
 * v1.4.0 plus the 1.5.0 updater's checkUpdatesOnStartup for V5, and 1.5.0
 * with Round 2's DNS defaults for V6). Schema versions 3 and 4 never reached a
 * tag, so their fixtures reuse V2's field set, which still carried
 * tunStrictRoute until v5 retired it. Unless a comment says otherwise, the
 * values are that release's defaults.
 *
 * These are historical records: they must NOT change when today's defaults
 * change, because they are what older installs actually have on disk.
 */

/** DNS defaults every release before Round 2 shipped (the generator ignored them). */
export const LEGACY_REMOTE_DNS = 'https://dns.google/dns-query';
export const LEGACY_DIRECT_DNS = 'https://dns.alidns.com/dns-query';

/**
 * DNS defaults from settings v6 on: the IP literals the generator emitted all
 * along, whatever the fields said (audit P0-8). Written out rather than
 * imported, so a changed default fails the migration suite instead of agreeing
 * with itself.
 */
export const V6_REMOTE_DNS = 'https://1.1.1.1/dns-query';
export const V6_DIRECT_DNS = 'https://223.5.5.5/dns-query';

/** v1.2.0 (no settingsVersion yet): IPv6 handling arrives, defaulting to 'block'. */
export const V1_BLOCK = {
  socksPort: 1080,
  httpPort: 8080,
  mixedPort: 7890,
  proxyMode: 'system',
  allowLan: false,
  ipv6Strategy: 'block',
  remoteDns: LEGACY_REMOTE_DNS,
  directDns: LEGACY_DIRECT_DNS,
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  theme: 'dark',
  splitRules: [],
  splitApps: [],
  splitMode: 'proxy',
};

/**
 * The electron-store `defaults.settings` of electron/main.ts before Round 2:
 * what a fresh install stores until the renderer first saves. No
 * settingsVersion and no ipv6Strategy.
 */
export const V1_FRESH_INSTALL = {
  socksPort: 1080,
  httpPort: 8080,
  mixedPort: 7890,
  proxyMode: 'system',
  remoteDns: LEGACY_REMOTE_DNS,
  directDns: LEGACY_DIRECT_DNS,
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  theme: 'dark',
};

/** v2: the default moved to 'prefer-ipv4'; separatePorts and tunStrictRoute exist. */
export const V2_PREFER = {
  settingsVersion: 2,
  socksPort: 1080,
  httpPort: 8080,
  separatePorts: false,
  mixedPort: 7890,
  proxyMode: 'system',
  allowLan: false,
  ipv6Strategy: 'prefer-ipv4',
  tunStrictRoute: true,
  remoteDns: LEGACY_REMOTE_DNS,
  directDns: LEGACY_DIRECT_DNS,
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  theme: 'dark',
  splitRules: [],
  splitApps: [],
  splitMode: 'proxy',
};

/** v3 with 'block' chosen explicitly (the v3 migration leaves it alone). */
export const V3_BLOCK = {
  ...V2_PREFER,
  settingsVersion: 3,
  ipv6Strategy: 'block',
};

/** v3 with its default, 'ipv4-only'. */
export const V3_IPV4_ONLY = {
  ...V2_PREFER,
  settingsVersion: 3,
  ipv6Strategy: 'ipv4-only',
};

/** v4 with 'ipv4-only' chosen explicitly and strict_route switched off (a WSL2/Docker workaround). */
export const V4_STRICT_OFF = {
  ...V2_PREFER,
  settingsVersion: 4,
  ipv6Strategy: 'ipv4-only',
  tunStrictRoute: false,
};

/**
 * v5 (current before Round 2): every current field, mostly NOT at its default
 * so "unchanged" is visible, plus a stray retired key. remoteDns is an edited
 * value and directDns the untouched legacy default.
 */
export const V5_CURRENT = {
  settingsVersion: 5,
  socksPort: 1081,
  httpPort: 8081,
  separatePorts: true,
  mixedPort: 7891,
  proxyMode: 'split',
  allowLan: true,
  ipv6Strategy: 'prefer-ipv4',
  tunBypassLocalNetworks: true,
  tunStack: 'gvisor',
  remoteDns: 'tls://8.8.8.8',
  directDns: LEGACY_DIRECT_DNS,
  bypassChina: false,
  logLevel: 'warn',
  autoStart: true,
  startMinimized: true,
  checkUpdatesOnStartup: false,
  theme: 'light',
  splitRules: [{ id: 'openai', name: 'OpenAI', outbound: 'proxy', ruleSets: ['geosite-openai'], enabled: true }],
  splitApps: ['chrome.exe'],
  splitMode: 'direct',
  tunStrictRoute: true,
};

/** v5 with both DNS servers edited (to no effect until v6) and everything else at the v5 defaults. */
export const V5_CUSTOM_DNS = {
  settingsVersion: 5,
  socksPort: 1080,
  httpPort: 8080,
  separatePorts: false,
  mixedPort: 7890,
  proxyMode: 'system',
  allowLan: false,
  ipv6Strategy: 'block',
  tunBypassLocalNetworks: false,
  tunStack: 'mixed',
  remoteDns: 'https://cloudflare-dns.com/dns-query',
  directDns: 'https://doh.pub/dns-query',
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  checkUpdatesOnStartup: true,
  theme: 'dark',
  splitRules: [],
  splitApps: [],
  splitMode: 'proxy',
};

/**
 * v6 (1.5.0 after Round 2): every current field, mostly NOT at its default.
 * remoteDns is the old dns.google default typed in again after the migration.
 * At v6 that is a deliberate choice and must stay: the v6 migration runs once.
 */
export const V6_CURRENT = {
  settingsVersion: 6,
  socksPort: 1081,
  httpPort: 8081,
  separatePorts: true,
  mixedPort: 7891,
  proxyMode: 'tun',
  allowLan: false,
  ipv6Strategy: 'ipv4-only',
  tunBypassLocalNetworks: true,
  tunStack: 'system',
  remoteDns: LEGACY_REMOTE_DNS,
  directDns: V6_DIRECT_DNS,
  bypassChina: false,
  logLevel: 'debug',
  autoStart: true,
  startMinimized: false,
  checkUpdatesOnStartup: false,
  theme: 'system',
  splitRules: [{ id: 'youtube', name: 'YouTube', outbound: 'auto', ruleSets: ['geosite-youtube'], enabled: false }],
  splitApps: [],
  splitMode: 'proxy',
};
